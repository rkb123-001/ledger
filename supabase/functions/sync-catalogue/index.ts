// Supabase Edge Function: sync-catalogue
// Pulls products and variants from Shopify and upserts them into
// budget_catalogue, so cost-order can tell when an enquiry is for a piece
// that already has a published price.
//
// Secrets required:
//   SHOPIFY_STORE_DOMAIN     e.g. cbea6e-3.myshopify.com
//   SHOPIFY_CLIENT_ID        Dev Dashboard app client ID
//   SHOPIFY_CLIENT_SECRET    Dev Dashboard app secret, starts shpss_
//   SHOPIFY_API_VERSION      optional, defaults below. Shopify retires versions
//                            roughly yearly, so this is overridable without a
//                            code change.
//
// Auth note: Shopify deprecated admin-created custom apps and their permanent
// shpat_ tokens on 1 January 2026. Dev Dashboard apps instead exchange a client
// ID and secret for a token that lives 24 hours. Since this sync is manual and
// occasional, a fresh token is fetched per run rather than cached, which makes
// expiry a non-issue.

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_API_VERSION = "2026-07";

const PRODUCTS_QUERY = `
query Products($cursor: String) {
  products(first: 50, after: $cursor, query: "status:active") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      title
      handle
      status
      variants(first: 100) {
        nodes {
          id
          title
          price
        }
      }
    }
  }
}`;

interface CatalogueRow {
  user_id: string;
  shopify_product_id: string;
  shopify_variant_id: string;
  title: string;
  variant_title: string | null;
  price: number;
  currency: string;
  handle: string | null;
  status: string;
  last_synced_at: string;
  updated_at: string;
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

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const domain = Deno.env.get("SHOPIFY_STORE_DOMAIN");
    const clientId = Deno.env.get("SHOPIFY_CLIENT_ID");
    const clientSecret = Deno.env.get("SHOPIFY_CLIENT_SECRET");
    const apiVersion = Deno.env.get("SHOPIFY_API_VERSION") ?? DEFAULT_API_VERSION;

    if (!domain || !clientId || !clientSecret) {
      return new Response(
        JSON.stringify({
          error: "Shopify not configured",
          detail:
            "Set SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET as Supabase secrets.",
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Client credentials grant. Only works when the app and the store sit in
    // the same Shopify organisation, which is the case for a store owner's own
    // app. Returns a token valid for 24 hours.
    const tokenRes = await fetch(`https://${domain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!tokenRes.ok) {
      const detail = await tokenRes.text();
      return new Response(
        JSON.stringify({
          error: "Could not get a Shopify token",
          status: tokenRes.status,
          detail,
          hint:
            "Check SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET, that the app is installed on this store, and that app and store are in the same Shopify organisation.",
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const tokenBody = await tokenRes.json();
    const token: string | undefined = tokenBody.access_token;
    const grantedScope: string = tokenBody.scope ?? "";

    if (!token) {
      return new Response(
        JSON.stringify({ error: "Shopify returned no access token", detail: tokenBody }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // A token with no read_products scope authenticates fine and then returns
    // nothing useful, which is a confusing failure. Catch it here instead.
    if (grantedScope && !grantedScope.includes("read_products")) {
      return new Response(
        JSON.stringify({
          error: "App is missing the read_products scope",
          detail: `Granted scopes: ${grantedScope || "(none)"}`,
          hint: "Add read_products to the app version in the Dev Dashboard, release it, then try again.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const endpoint = `https://${domain}/admin/api/${apiVersion}/graphql.json`;
    const rows: CatalogueRow[] = [];
    const now = new Date().toISOString();
    let cursor: string | null = null;
    let pages = 0;

    // Paginate. Capped so a runaway store cannot spin here forever.
    while (pages < 40) {
      pages++;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query: PRODUCTS_QUERY, variables: { cursor } }),
      });

      if (!res.ok) {
        const detail = await res.text();
        return new Response(
          JSON.stringify({
            error: "Shopify API failed",
            status: res.status,
            detail,
            hint:
              res.status === 404
                ? `API version ${apiVersion} may be retired. Set the SHOPIFY_API_VERSION secret to a current one.`
                : res.status === 401 || res.status === 403
                ? "The token was issued but rejected. Check the app is installed on this store and has read_products."
                : undefined,
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const payload = await res.json();

      // GraphQL returns 200 with an errors array, so this has to be checked
      // separately from res.ok.
      if (payload.errors) {
        return new Response(
          JSON.stringify({ error: "Shopify GraphQL error", detail: payload.errors }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const products = payload.data?.products;
      if (!products) break;

      for (const p of products.nodes ?? []) {
        for (const v of p.variants?.nodes ?? []) {
          rows.push({
            user_id: user.id,
            shopify_product_id: String(p.id),
            shopify_variant_id: String(v.id),
            title: p.title,
            // Shopify uses "Default Title" for products with no real options.
            variant_title: v.title && v.title !== "Default Title" ? v.title : null,
            price: Number(v.price) || 0,
            currency: "GBP",
            handle: p.handle ?? null,
            status: (p.status ?? "ACTIVE").toLowerCase(),
            last_synced_at: now,
            updated_at: now,
          });
        }
      }

      if (!products.pageInfo?.hasNextPage) break;
      cursor = products.pageInfo.endCursor;
    }

    if (rows.length === 0) {
      return new Response(
        JSON.stringify({ synced: 0, note: "Shopify returned no active products." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { error: upsertError } = await supabase
      .from("budget_catalogue")
      .upsert(rows, { onConflict: "user_id,shopify_variant_id" });

    if (upsertError) {
      return new Response(
        JSON.stringify({ error: "Could not save catalogue", detail: upsertError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Anything not touched by this run is no longer active in Shopify.
    await supabase
      .from("budget_catalogue")
      .update({ status: "archived", updated_at: now })
      .eq("user_id", user.id)
      .lt("last_synced_at", now);

    const products = new Set(rows.map((r) => r.shopify_product_id)).size;

    return new Response(
      JSON.stringify({ synced: rows.length, products, synced_at: now }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Unexpected error", detail: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
