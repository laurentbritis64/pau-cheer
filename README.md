# Application Pau Cheerleading

Application du club, installable sur téléphone (iPhone et Android) depuis le navigateur :
planning des entraînements et compétitions par équipe, tchats d'équipe, messages privés avec le bureau,
organisation des déplacements (départ, déroulé, checklist « À emporter », présences) et envoi de documents.

## Comment ça marche

- **Le site** (ce dossier) est hébergé gratuitement sur GitHub Pages.
- **Les données** (comptes, messages, documents…) sont dans un projet Supabase gratuit, hébergé en Europe.
- Les règles d'accès sont dans la base elle-même (`supabase/schema.sql`) :
  - un athlète ne voit que le tchat et le planning de son équipe ;
  - un parent voit les équipes de tous ses enfants ;
  - les messages privés ne sont visibles que par les deux personnes, et seul le bureau peut écrire à n'importe qui ;
  - les documents d'un athlète ne sont visibles que par lui, ses parents et le bureau.

## Mise en place (une seule fois)

1. **Créer la base** : dans Supabase, ouvrir *SQL Editor*, coller tout le contenu de `supabase/schema.sql`, cliquer sur *Run*.
2. **Réglages de connexion** dans Supabase, menu *Authentication* :
   - *Sign In / Providers > Email* : désactiver **Confirm email** (le bureau valide déjà chaque compte, et l'envoi d'e-mails gratuit est limité à quelques-uns par heure).
   - *URL Configuration* : mettre l'adresse de l'app dans **Site URL** (par exemple `https://NOM-DU-COMPTE.github.io/pau-cheer/`), pour que les liens « mot de passe oublié » ramènent vers l'app.
3. **Relier l'app à la base** : renseigner `url` et `anonKey` dans `config.js` (Supabase > *Project Settings > API*).
4. **Publier** : sur GitHub, *Settings > Pages*, source « Deploy from a branch », branche `main`, dossier `/ (root)`.

## Premier démarrage

1. Le **premier compte créé devient automatiquement membre du bureau** : c'est le compte du responsable de l'app.
2. Les athlètes et les parents créent ensuite leur compte depuis l'app. Un parent indique à l'inscription le prénom, le nom, la date de naissance et l'équipe de chaque enfant (un enfant sans téléphone n'a pas besoin de compte). Si les deux parents inscrivent le même enfant, ils sont reliés au même enfant. Les comptes arrivent « en attente ».
3. Dans l'onglet **Bureau**, le bureau valide chaque compte : athlète (avec son équipe), parent (avec ses enfants) ou bureau.

## Installer l'app sur un téléphone

- **iPhone** : ouvrir le lien dans Safari, bouton *Partager*, puis *Sur l'écran d'accueil*.
- **Android** : ouvrir le lien dans Chrome, puis *Installer l'application* (ou le bouton « Installer » dans l'app).

## Mettre à jour l'app

Après une modification des fichiers, changer le numéro `VERSION` dans `sw.js` pour que les téléphones prennent la nouvelle version.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | l'application |
| `config.js` | adresse et clé publique de la base Supabase |
| `manifest.webmanifest`, `sw.js`, `icons/` | installation sur l'écran d'accueil et fonctionnement hors ligne |
| `vendor/supabase.js` | bibliothèque officielle Supabase (version 2.118.0, licence MIT) |
| `supabase/schema.sql` | tables, règles d'accès, équipes et entraînements de la saison |
