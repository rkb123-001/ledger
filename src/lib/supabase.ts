import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !anonKey) {
  console.error("Missing Supabase environment variables");
}

export const supabase = createClient(url, anonKey);

export const ALLOWED_EMAIL = (import.meta.env.VITE_ALLOWED_EMAIL as string)?.toLowerCase();
