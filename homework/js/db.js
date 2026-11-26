// Supabase client and small data helpers.

const cfg = window.HW_CONFIG || {};
export const configured = Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);

export const sb = configured
  ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { flowType: 'implicit', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

// Throw on Supabase errors so callers can use try/catch.
export async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

export function rpc(name, args) {
  return q(sb.rpc(name, args));
}

export function portalUrl() {
  return new URL('./', window.location.href).href.split('#')[0];
}

// Signed, short-lived link to a private file.
export async function signedUrl(bucket, path, seconds = 3600) {
  const data = await q(sb.storage.from(bucket).createSignedUrl(path, seconds));
  return data.signedUrl;
}

export function uuid() {
  return crypto.randomUUID();
}

// Safe storage file name: keep letters, numbers, dot, dash.
export function safeName(name) {
  const base = (name || 'file').normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-');
  return base.slice(-80) || 'file';
}
