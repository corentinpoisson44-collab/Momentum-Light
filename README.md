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
| 6 | **Export enrichi (.png)** — injecte une entrée `Image enrichie Momentum (.png)` dans le menu natif `… › Export` de la Timeline. Capture la Timeline visible à l'écran en conservant son format natif (via `html2canvas`) avec **tous les overlays Momentum-Light** (barres de progression sur les Epics, chiffrage SP, badges T-Shirt, confiance, chips de sprint colorés, bandeau vélocité). Racine de capture : `#sr-timeline` en priorité, fallback sur `[data-testid^="roadmap.timeline-table-kit"]` puis `[role="main"]`. Une seule passe sur la fenêtre courante — pour couvrir un plan qui déborde de l'écran, scrollez puis relancez l'export autant de fois que nécessaire. | ✅ v0.7.5 |
| 7 | **Vue PM / Vue Business** — toggle segmenté dans le bandeau Momentum (en haut de la Timeline) qui bascule l'affichage des overlays d'Epic. La **Vue PM** garde le comportement historique (progression SP, chiffrage des tickets, badge T-Shirt, confiance). La **Vue Business** remplace chaque overlay d'Epic par sa **date d'atterrissage** (`duedate`) formatée en français, masque les overlays de tickets, et cache les légendes PM-only. Le choix est persisté dans `localStorage`. | ✅ v0.8.0 |
| 8 | **Statut business 🟢🟡🔴** — en Vue Business, chaque barre d'Epic est recolorée selon son statut ternaire (`On Track` vert, `At Risk` orange, `Off Track` rouge, `Livré` gris). Calculé à partir de la `duedate`, de la projection de fin via la vélocité moyenne, de la confidence et de la status category — aucune nouvelle requête API. Le pourquoi du statut s'affiche dans la première ligne du tooltip (ex. `Statut : Off Track 🔴 — Fin estimée 15 juin 2026, due 30 mai 2026 (+16 j)`). | ✅ v0.9.0 |
| 9 | **Export business-friendly (.png)** — en Vue Business, l'entrée `Image enrichie Momentum (.png)` produit une variante avec une bande titre `Roadmap Produit — T<n> <année>` et une légende des couleurs de statut composée au-dessus de la Timeline capturée. Le fichier est nommé `momentum-roadmap-business-<iso>.png`. En Vue PM, l'export reste strictement inchangé. | ✅ v0.9.0 |
| 10 | **Statistiques de sprint (Backlog)** — sur la vue Backlog, chaque sprint (actif ou à venir) gagne un bouton `📊 Statistiques` dans son en-tête. Un clic déplie un panneau de camemberts SVG qui décomposent la composition du sprint selon les dimensions choisies par l'utilisateur : **Type** d'issue, **Statut** (À faire / En cours / Terminé), **Assigné**, et **Epic parente**. Toggle `Tickets ↔ SP` pour basculer la pondération. Les préférences (mode + dimensions cochées) et l'état ouvert/fermé de chaque panneau sont persistés dans `localStorage` pour survivre au refresh. Les camemberts sont dessinés en SVG natif (aucune nouvelle dépendance). | ✅ v0.10.0 |

### Configuration

- **Vélocité — sélection du board** : par défaut, le userscript détecte le board scrum via l'URL (`/boards/<id>/...`) ou prend le premier board scrum accessible. Pour forcer un board précis :
  ```js
  localStorage.setItem('momentum-light::velocity-board-id', '123')
  ```
- **Statuts custom — reclassification** : certaines équipes définissent des statuts JIRA custom (`"Ready for UAT"`, `"En recette"`, `"MEP effectuée"`…) que l'admin laisse souvent dans la catégorie `"To Do"`. Momentum-Light détecte automatiquement les motifs les plus courants (FR + EN) pour redresser la classification et ne plus compter ces tickets comme non-démarrés dans le calcul de confiance / progression d'Epic. Pour les statuts que les patterns par défaut ne reconnaîtraient pas, un override explicite est possible via `localStorage` :
  ```js
  localStorage.setItem('momentum-light::status-overrides', JSON.stringify({
    'EN RECETTE CLIENT': 'indeterminate',
    'VALIDATION BUSINESS': 'indeterminate',
    'MEP EFFECTUÉE': 'done',
  }))
  ```
  Les clés sont matchées case-insensitive contre le nom trimé du statut ; les valeurs doivent être `'new'`, `'indeterminate'` ou `'done'`. Un override supplante tout (y compris une catégorie JIRA non-`new`). En mode debug (voir ci-dessous), chaque reclassification est loguée une fois pour faciliter la vérification.
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
- `sprintComposition` — breakdown d'un sprint (type / statut / assigné / Epic parent) via un JQL `sprint = <id>` avec cache mémoire 60 s. Alimente le panneau de statistiques du Backlog
- `timelineDom` — détection des barres, extraction de l'issue key, injection des overlays (progression Epic ou chiffrage ticket)
- `sprintChipDom` — détection des chips de sprint dans la ligne « Sprints » + injection d'un overlay de remplissage coloré
- `backlogDom` — détection des conteneurs de sprint sur la vue Backlog (`data-testid` contenant `sprint-<id>`) + extraction nom / état
- `sprintStatsPanel` — bouton `📊 Statistiques` + panneau dépliable rendant les camemberts SVG par dimension. Préférences utilisateur persistées (`momentum-light::stats-prefs`), sprints ouverts persistés (`momentum-light::stats-open-sprints`)
- `velocityBanner` — bandeau fixe sur les vues timeline/plan
- `howto` — bouton flottant `?` + overlay de visite guidée (spotlight + carte étape par étape, navigable via _Précédent_ / _Suivant_ / _Passer_, auto-lancée une fois par navigateur)
- `exportPng` — surcharge du menu natif `… › Export` : observe les popovers Atlaskit, injecte une entrée `Image enrichie Momentum (.png)` après `Image (.png)`. Au clic, `findCaptureRoot` privilégie `#sr-timeline`, avec fallback sur le conteneur Advanced Roadmaps (`data-testid` préfixé `roadmap.timeline-table-kit`) puis `[role="main"]`. `html2canvas` (bundlé par la directive `@require` pour contourner la CSP Atlassian) est appelé une seule fois sur la fenêtre courante — pas de scroll-and-stitch : Plans virtualisant ses lignes, essayer de capturer plus que la viewport se battait contre le framework. Pour couvrir un plan qui déborde, l'utilisateur scrolle et relance l'export (assemblage manuel plus fiable qu'en navigateur). Les éléments transients (menus, tooltips, overlays How-to, toast de progression) sont filtrés via `ignoreElements`. Le canvas résultant est téléchargé en `momentum-timeline-<iso>.png`
- `features[]` — registre des features, avec cycle de vie `onMutation` / `onInactive`

## Licence

MIT.
