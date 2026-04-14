# Momentum-Light

Userscript versionné qui augmente la **Timeline JIRA** (Plans / Advanced Roadmaps) directement dans le navigateur, sans installer de plugin côté serveur.

Inspiré de [Momentum](https://github.com/corentinpoisson44-collab/momentum), en version "light" : un seul fichier `.user.js` à installer via Tampermonkey / Violentmonkey, auto-update inclus.

## Installation

1. Installer une extension de userscripts :
   - [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Safari)
   - ou [Violentmonkey](https://violentmonkey.github.io/) (open-source)
2. Cliquer sur le lien d'installation en un clic :
   👉 **[momentum-light.user.js](https://raw.githubusercontent.com/corentinpoisson44-collab/Momentum-Light/main/momentum-light.user.js)**
3. L'extension proposera l'installation — confirmer.
4. Ouvrir une Timeline JIRA Cloud (`*.atlassian.net`) — les features s'activent automatiquement.

Les mises à jour sont poussées automatiquement (Tampermonkey vérifie le `@updateURL` toutes les 24 h ; un bump `@version` sur `main` suffit).

## Features

| # | Feature | État |
|---|---|---|
| 1 | **Epic Progress Bar** — affiche une barre de progression sur chaque Epic de la Timeline, calculée sur `Σ SP done / Σ SP total` des tickets enfants. | ✅ v0.1.0 |

## Développement

Le userscript est un fichier unique, sans build chain : éditer `momentum-light.user.js`, bumper `@version` selon SemVer, commit & push sur `main`. Tampermonkey propagera la mise à jour.

Structure interne :
- `jiraApi` — wrappers `fetch` sur `/rest/api/3/*` (same-origin, cookies de session réutilisés)
- `storyPointsField` — découverte dynamique du custom field Story Points (cache `sessionStorage`)
- `epicProgress` — calcul SP done / total des enfants d'un Epic (cache mémoire 60 s)
- `timelineDom` — détection des barres, extraction de l'issue key, injection de l'overlay
- `features[]` — registre pour ajouter de nouvelles features Momentum

## Licence

MIT.
