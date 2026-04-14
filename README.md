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
| 2 | **Ticket Estimate** — sous les Epics, chaque barre de ticket affiche son chiffrage (centré) en Story Points. | ✅ v0.2.1 |
| 3 | **Sprint Velocity** — chip intégrée dans le toolbar de la Timeline, affichant la vélocité moyenne des 5 derniers sprints clos. | ✅ v0.2.1 |

### Configuration

- **Vélocité — sélection du board** : par défaut, le userscript détecte le board scrum via l'URL (`/boards/<id>/...`) ou prend le premier board scrum accessible. Pour forcer un board précis :
  ```js
  localStorage.setItem('momentum-light::velocity-board-id', '123')
  ```
- **Debug** : `localStorage.setItem('momentum-light-debug', '1')` dans la console du navigateur.

## Développement

Le userscript est un fichier unique, sans build chain : éditer `momentum-light.user.js`, bumper `@version` selon SemVer, commit & push sur `main`. Tampermonkey propagera la mise à jour.

Structure interne :
- `jiraApi` — wrappers `fetch` sur `/rest/api/3/*` et `/rest/agile/1.0/*` (same-origin, cookies de session réutilisés)
- `storyPointsField` — découverte dynamique du custom field Story Points (cache `sessionStorage`)
- `issueMeta` — lookup `{ isEpic, storyPoints }` batché via JQL `key in (...)` (cache mémoire 60 s)
- `epicProgress` — calcul SP done / total des enfants d'un Epic (cache mémoire 60 s)
- `velocity` — vélocité moyenne des N derniers sprints clos (cache mémoire 5 min)
- `timelineDom` — détection des barres, extraction de l'issue key, injection des overlays (progression Epic ou chiffrage ticket)
- `velocityBanner` — bandeau fixe sur les vues timeline/plan
- `features[]` — registre des features, avec cycle de vie `onMutation` / `onInactive`

## Licence

MIT.
