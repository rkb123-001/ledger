// Supabase Edge Function: cost-order
// Receives a screenshot of a client order, plus the user's production cost rate card,
// and returns a structured cost estimate with per-piece breakdowns.

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ProductionCostRow {
  category: string;
  description: string;
  cost_low: number;
  cost_high: number;
  pot_name: string | null;
  notes: string | null;
}

interface CostBreakdownLine {
  description: string;
  amount: number;
  pot_name: string | null;
  is_estimate: boolean;
}

interface CostedPiece {
  name: string;
  quantity: number;
  notes: string;
  breakdown: CostBreakdownLine[];
  production_cost: number;
}

interface CostingResult {
  client_name: string | null;
  order_reference: string | null;
  pieces: CostedPiece[];
  production_subtotal: number;
  margin_multiplier: number;
  suggested_retail: number;
  warnings: string[];
}

function buildSystemPrompt(rateCard: ProductionCostRow[]): string {
  const rateCardText = rateCard
    .map(
      (r) =>
        `- ${r.category} | ${r.description} | £${r.cost_low.toFixed(2)}–£${r.cost_high.toFixed(2)}` +
        (r.pot_name ? ` | pot: ${r.pot_name}` : "") +
        (r.notes ? ` | ${r.notes}` : "")
    )
    .join("\n");

  return `You are costing a jewellery studio order from a screenshot of a client order or specification.

The user is Rebekah Kosonen Bide, who runs an independent fine jewellery practice based in London.

Use ONLY the production rate card below to estimate costs. Use the midpoint of each range unless the piece's complexity clearly suggests low or high end.

PRODUCTION RATE CARD:
${rateCardText}

Return ONLY valid JSON in this exact shape, no markdown, no commentary:

{
  "client_name": "string or null — extract from email signature, order header, etc.",
  "order_reference": "string or null — order number, invoice reference",
  "pieces": [
    {
      "name": "string — short descriptive name of the piece (e.g. 'Splintered Heart Locket in silver on delicate chain')",
      "quantity": number,
      "notes": "string — anything notable about complexity, finish, materials",
      "breakdown": [
        {
          "description": "string — specific cost line (e.g. 'Silver pendant casting', 'Gold vermeil plating', 'Delicate silver chain')",
          "amount": number,
          "pot_name": "string or null — which pot from the rate card this maps to (e.g. 'Casters', 'Hallmarking', 'Plating', 'Hatton Garden materials')",
          "is_estimate": true
        }
      ],
      "production_cost": number
    }
  ],
  "production_subtotal": number,
  "margin_multiplier": number,
  "suggested_retail": number,
  "warnings": [
    "string — anything ambiguous, missing info, or that the user should double-check"
  ]
}

COSTING RULES:
- Multiply per-piece costs by quantity. e.g. if the order is 4 stud earrings = 2 pairs, that's 2x earring casting + 2x hallmarking.
- Always include hallmarking for solid silver or gold pieces.
- Always include casting for any cast piece.
- Include plating only for vermeil, gold-plated, or silver-plated pieces (not for solid silver or solid gold).
- Include chain costs only for pendant/locket pieces specified to come on a chain.
- Add labour/studio time per piece when the piece involves hand-finishing, engraving, or assembly.
- production_cost per piece = sum of its breakdown amounts.
- production_subtotal = sum of all (production_cost * quantity) across pieces.
- Default margin_multiplier to 4. Use 5 only if the order is clearly DTC retail rather than wholesale or commission.
- suggested_retail = production_subtotal * margin_multiplier, rounded up to nearest £5.
- If the screenshot is unclear, partially visible, or missing key info (materials, sizes, finish), add a warning rather than guessing.
- If a piece has no obvious match in the rate card, still cost it using the closest analogue and add a warning.

Return only the JSON object. No prose.`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { image, mediaType, additionalContext } = await req.json();
    if (!image || !mediaType) {
      return new Response(JSON.stringify({ error: "Missing image or mediaType" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch the user's rate card
    const { data: rateCardRows } = await supabase
      .from("budget_production_costs")
      .select("category, description, cost_low, cost_high, pot_name, notes")
      .eq("user_id", user.id)
      .order("sort_order", { ascending: true });

    const rateCard: ProductionCostRow[] = (rateCardRows ?? []).map((r: any) => ({
      category: r.category,
      description: r.description,
      cost_low: Number(r.cost_low),
      cost_high: Number(r.cost_high),
      pot_name: r.pot_name,
      notes: r.notes,
    }));

    if (rateCard.length === 0) {
      return new Response(
        JSON.stringify({
          error: "No production cost reference set up. Add some rates in the Production Costs settings first.",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const systemPrompt = buildSystemPrompt(rateCard);
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicKey) {
      return new Response(JSON.stringify({ error: "Server not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userTextPrompt = additionalContext
      ? `Cost this client order. Additional notes from the user: ${additionalContext}`
      : "Cost this client order. Return the JSON.";

    const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 4000,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: image },
              },
              { type: "text", text: userTextPrompt },
            ],
          },
        ],
      }),
    });

    if (!anthropicResponse.ok) {
      const errText = await anthropicResponse.text();
      return new Response(
        JSON.stringify({ error: "Anthropic API failed", detail: errText }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const anthropicData = await anthropicResponse.json();
    const textBlock = anthropicData.content?.find((b: any) => b.type === "text");
    if (!textBlock?.text) {
      return new Response(JSON.stringify({ error: "No text in Anthropic response" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const cleanedText = textBlock.text.replace(/```json\s*|\s*```/g, "").trim();

    let parsed: CostingResult;
    try {
      parsed = JSON.parse(cleanedText);
    } catch {
      return new Response(
        JSON.stringify({
          error: "Could not parse model output as JSON",
          raw: cleanedText,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!parsed.pieces || !Array.isArray(parsed.pieces)) {
      return new Response(JSON.stringify({ error: "Invalid response shape" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Unexpected error", detail: String(err) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
