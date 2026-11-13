// Fonction Supabase « notify » : envoie les notifications sur les téléphones (Web Push).
// À créer dans Supabase > Edge Functions > Deploy a new function > Via Editor,
// avec le nom « notify », en désactivant « Verify JWT ».
// Elle n'a besoin d'aucun réglage : les clés sont créées toutes seules au premier appel
// et rangées dans la table privée notify_config.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function keys() {
  const { data: cfg, error } = await sb.from("notify_config").select("*").eq("id", 1).single();
  if (error || !cfg) throw new Error("notify_config manquante : passe la mise à jour 18");
  if (!cfg.vapid_public || !cfg.vapid_private) {
    const k = webpush.generateVAPIDKeys();
    // Une seule création, même si deux appels arrivent en même temps
    await sb.from("notify_config").update({ vapid_public: k.publicKey, vapid_private: k.privateKey })
      .eq("id", 1).is("vapid_public", null);
    return keys();
  }
  return cfg;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const cfg = await keys();
    // Le téléphone demande la clé publique pour s'abonner
    if (req.method === "GET") return json({ publicKey: cfg.vapid_public });

    // La base demande d'envoyer une notification
    const msg = await req.json();
    if (!msg || msg.secret !== cfg.secret) return json({ error: "interdit" }, 403);
    const users: string[] = (msg.users || []).slice(0, 2000);
    if (!users.length) return json({ sent: 0 });
    webpush.setVapidDetails("mailto:contact@pau-cheerleading.com", cfg.vapid_public, cfg.vapid_private);
    const { data: subs } = await sb.from("push_subscriptions").select("*").in("user_id", users);
    const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url || "./", tag: msg.tag || undefined });
    let sent = 0;
    await Promise.all((subs || []).map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload,
          { TTL: 60 * 60 * 24, urgency: "high" });
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        // Abonnement expiré (application désinstallée, notifications coupées…)
        if (code === 404 || code === 410) await sb.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      }
    }));
    return json({ sent });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
