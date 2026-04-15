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

> Le script déclare `@require https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js` pour fournir `html2canvas` à la feature d'export enrichi — Tampermonkey/Violentmonkey téléchargent cette dépendance au premier chargement du userscript, puis la mettent en cache. Aucune configuration manuelle n'est requise.

## Features

| # | Feature | État |
|---|---|---|
| 1 | **Epic Progress Bar** — affiche une barre de progression sur chaque Epic de la Timeline, calculée sur `Σ SP done / Σ SP total` des tickets enfants. | ✅ v0.1.0 |
| 2 | **Ticket Estimate** — sous les Epics, chaque barre de ticket affiche son chiffrage (centré) en Story Points. | ✅ v0.2.1 |
| 3 | **Sprint Velocity** — chip intégrée dans le toolbar de la Timeline, affichant la vélocité moyenne des 5 derniers sprints clos. | ✅ v0.2.1 |
| 4 | **Sprint Fill Indicator** — barre de remplissage dans chaque chip de sprint actif/futur de la ligne « Sprints », comparant le SP chargé à la vélocité moyenne (vert < 90 %, ambre 90–110 %, rouge > 110 %). | ✅ v0.3.0 |
| 5 | **How-to Menu** — bouton flottant `?` qui lance une visite guidée surlignant chaque feature, étape par étape, avec boutons _Précédent_ / _Suivant_ / _Passer_. Auto-lancé au premier chargement d'une Timeline, puis accessible à tout moment via le bouton. | ✅ v0.4.0 |
| 6 | **Export enrichi (.png)** — injecte une entrée `Image enrichie Momentum (.png)` dans le menu natif `… › Export` de la Timeline. Capture la Timeline en conservant son format natif (via `html2canvas`) avec **tous les overlays Momentum-Light visibles** (barres de progression sur les Epics, chiffrage SP, badges T-Shirt, confiance, chips de sprint colorés, bandeau vélocité). La racine de capture prioritaire est `#sr-timeline` (Plans y rend l'intégralité du plan à sa hauteur intrinsèque, donc une seule passe suffit). En fallback sur les vues qui virtualisent les lignes, le conteneur interne est scrollé par paliers, chaque tranche capturée et l'image recomposée en recadrant l'en-tête collant. Une étiquette discrète « Momentum-Light · date » est apposée en bas à droite. | ✅ v0.7.3 |

### Configuration

- **Vélocité — sélection du board** : par défaut, le userscript détecte le board scrum via l'URL (`/boards/<id>/...`) ou prend le premier board scrum accessible. Pour forcer un board précis :
  ```js
  localStorage.setItem('momentum-light::velocity-board-id', '123')
  ```
- **Debug** : `localStorage.setItem('momentum-light-debug', '1')` dans la console du navigateur.
- **Relancer le guide How-to** : cliquez sur le bouton flottant `?` en bas à droite, ou exécutez `localStorage.removeItem('momentum-light::howto-seen')` puis rechargez la page pour forcer l'auto-lancement.

## Développement

Le userscript est un fichier unique, sans build chain : éditer `momentum-light.user.js`, bumper `@version` selon SemVer, commit & push sur `main`. Tampermonkey propagera la mise à jour.

Structure interne :
- `jiraApi` — wrappers `fetch` sur `/rest/api/3/*` et `/rest/agile/1.0/*` (same-origin, cookies de session réutilisés)
- `storyPointsField` — découverte dynamique du custom field Story Points (cache `sessionStorage`)
- `issueMeta` — lookup `{ isEpic, storyPoints }` batché via JQL `key in (...)` (cache mémoire 60 s)
- `epicProgress` — calcul SP done / total des enfants d'un Epic (cache mémoire 60 s)
- `velocity` — vélocité moyenne des N derniers sprints clos + liste des sprints actifs/futurs pour le planning (cache mémoire 5 min)
- `sprintCapacity` — SP total/restant d'un sprint donné via `/rest/agile/1.0/sprint/{id}/issue` (cache mémoire 60 s)
- `timelineDom` — détection des barres, extraction de l'issue key, injection des overlays (progression Epic ou chiffrage ticket)
- `sprintChipDom` — détection des chips de sprint dans la ligne « Sprints » + injection d'un overlay de remplissage coloré
- `velocityBanner` — bandeau fixe sur les vues timeline/plan
- `howto` — bouton flottant `?` + overlay de visite guidée (spotlight + carte étape par étape, navigable via _Précédent_ / _Suivant_ / _Passer_, auto-lancée une fois par navigateur)
- `exportPng` — surcharge du menu natif `… › Export` : observe les popovers Atlaskit, injecte une entrée `Image enrichie Momentum (.png)` après `Image (.png)`. Au clic, `findCaptureRoot` privilégie `#sr-timeline` (conteneur rendu par Plans à sa hauteur intrinsèque, donc une seule passe html2canvas suffit pour embarquer tous les Epics), sinon il retombe sur le conteneur Advanced Roadmaps (`data-testid` préfixé `roadmap.timeline-table-kit`, fallback sur `[role="main"]`). `html2canvas` est bundlé par la directive `@require` pour contourner la CSP Atlassian. Lorsque la racine choisie expose un conteneur virtualisé interne, `captureTimeline` le scrolle par paliers de `viewportHeight - stickyHeaderHeight - 24px`, capture chaque tranche après une attente de ~450 ms (temps que la virtualisation puis notre décorateur MutationObserver appliquent leurs overlays), puis recompose l'image finale via `stitchVertical` en recadrant l'en-tête collant sur chaque tranche après la première. Les éléments transients (menus, tooltips, overlays How-to, toast de progression) sont filtrés via `ignoreElements`. Un toast affiche la progression (`rendu…` ou `capture X/Y…` + `assemblage…`). Une étiquette `Momentum-Light · date` est peinte sur le canvas résultant avant téléchargement en `momentum-timeline-<iso>.png`
- `features[]` — registre des features, avec cycle de vie `onMutation` / `onInactive`

## Licence

MIT.
