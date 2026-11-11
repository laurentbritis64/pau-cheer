-- =====================================================================
-- Mise à jour 16 : supprimer un message « pour moi » (comme WhatsApp)
-- À coller dans Supabase > SQL Editor > New query > Run (après la mise à jour 15)
-- Peut être relancée sans risque.
-- =====================================================================
-- Messages masqués pour moi seulement, conversation par conversation
alter table public.chat_prefs add column if not exists hidden uuid[] not null default '{}';
