// Supabase Edge Function: parse-screenshot
// Receives base64 image, calls Anthropic API with vision, returns structured drafts

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ParsedItem {
  label: string;
  amount: number;
  suggested_pot: string;
  is_estimate: boolean;
}

const SYSTEM_PROMPT = `You are extracting jewellery studio budget items from a screenshot of a task list.

Return ONLY valid JSON in this exact shape, no markdown, no commentary:

{
  "items": [
    {
      "label": "string — short description with what the cost covers (e.g. 'Henry Curchod — VAT on invoice', 'Skin Doctor brooch — silver hallmark stamp')",
      "amount": number,
      "suggested_pot": "VAT" | "Casters" | "Hallmarking" | "Shipping" | "Plating" | "Hatton Garden materials" | "VAT return (quarterly)" | "Hair" | "Special Projects / Editorial" | "Tax Return" | "Other",
      "is_estimate": boolean
    }
  ]
}

POT CATEGORISATION RULES:
- "VAT" — anything mentioning VAT on a client invoice (e.g. "Henry Curchod VAT £55")
- "Casters" — casting fees, lost-wax casting, "casting + metal", payments to casters
- "Hallmarking" — hallmark stamping fees at the assay office
- "Shipping" — postage, tracked delivery, courier fees
- "Plating" — gold plating, vermeil plating, silver plating, electroforming
- "Hatton Garden materials" — chains, findings, packaging, raw silver/gold, tools, plating equipment
- "VAT return (quarterly)" — accountant fees specifically for VAT returns
- "Hair" — hair appointments
- "Special Projects / Editorial" — silicone moulds, R&D tooling, editorial production
- "Tax Return" — tax return reserve, accountant fees for self-assessment
- "Other" — only if genuinely none of the above fit

EXTRACTION RULES:
- Ignore checkboxes, bullet points, and the leading "0" from translated checkboxes.
- Currency symbols are usually £; treat any number after £ as the amount.
- If a line has no amount, skip it entirely. Do not guess.
- Decimal amounts: "£77.784" → 77.78 (round to 2dp).
- If the line says "(est.)", "estimate", "approx", "~", set is_estimate to true.
- Preserve UK spelling and the user's punctuation style: use em-dashes sparingly (only if present in source); prefer the format "Item name — what it covers".
- If a line is ambiguous (no clear amount, unclear category), skip it rather than guess.

Return only the JSON object. No prose before or after.`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Verify auth
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

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse request
    const { image, mediaType } = await req.json();
    if (!image || !mediaType) {
      return new Response(JSON.stringify({ error: "Missing image or mediaType" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Call Anthropic API
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicKey) {
      return new Response(JSON.stringify({ error: "Server not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: image,
                },
              },
              {
                type: "text",
                text: "Extract all budget items from this screenshot and return the JSON.",
              },
            ],
          },
        ],
      }),
    });

    if (!anthropicResponse.ok) {
      const errText = await anthropicResponse.text();
      return new Response(JSON.stringify({ error: "Anthropic API failed", detail: errText }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anthropicData = await anthropicResponse.json();
    const textBlock = anthropicData.content?.find((b: any) => b.type === "text");
    if (!textBlock?.text) {
      return new Response(JSON.stringify({ error: "No text in Anthropic response" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Strip markdown fences if present
    const cleanedText = textBlock.text.replace(/```json\s*|\s*```/g, "").trim();

    let parsed: { items: ParsedItem[] };
    try {
      parsed = JSON.parse(cleanedText);
    } catch (parseErr) {
      return new Response(JSON.stringify({
        error: "Could not parse model output as JSON",
        raw: cleanedText,
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!parsed.items || !Array.isArray(parsed.items)) {
      return new Response(JSON.stringify({ error: "Invalid response shape" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Look up the user's existing pots to map suggested_pot names to IDs
    const { data: pots } = await supabase
      .from("budget_pots")
      .select("id, name")
      .eq("user_id", user.id);

    const potMap = new Map((pots ?? []).map((p) => [p.name.toLowerCase(), p.id]));

    // Insert drafts
    const draftsToInsert = parsed.items
      .filter((item) => typeof item.amount === "number" && item.amount > 0 && item.label)
      .map((item) => ({
        user_id: user.id,
        suggested_pot_id: potMap.get(item.suggested_pot?.toLowerCase()) ?? null,
        suggested_pot_name: item.suggested_pot ?? "Other",
        label: item.label,
        amount: item.amount,
        is_estimate: !!item.is_estimate,
        status: "pending",
      }));

    if (draftsToInsert.length === 0) {
      return new Response(JSON.stringify({ items: [], message: "No valid items extracted" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: insertedDrafts, error: insertError } = await supabase
      .from("budget_drafts")
      .insert(draftsToInsert)
      .select();

    if (insertError) {
      return new Response(JSON.stringify({ error: "Failed to save drafts", detail: insertError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ items: insertedDrafts ?? [] }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Unexpected error", detail: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
