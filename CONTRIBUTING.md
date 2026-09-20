# Contribuer à la base de citations

L'objectif : **au moins une citation vérifiée par jour de l'année** (366 jours, 29 février
compris), avec assez de variété pour que le même jour d'une année sur l'autre n'affiche pas la
même citation. Viser 3 à 5 entrées par jour.

## La règle qui prime sur toutes les autres

**Le texte d'une citation est copié depuis sa source. Il n'est jamais rédigé, reformulé,
complété, traduit puis retraduit, ni reconstitué de mémoire.**

Une citation attribuée à une personne réelle et mal citée, mal datée ou inventée est une faute
que ce projet refuse de commettre. D'où le reste des règles.

- Une entrée n'est **affichée** que si `"verified": true`.
- `verified` se met à `true` par un acte humain : quelqu'un a ouvert `source_url`, lu le texte,
  vérifié la date, et constaté que les deux correspondent.
- Pas de commentaire éditorial. Le champ `context` décrit le cadre factuel en une ligne
  (support, lieu, événement), sans adjectif d'appréciation.
- Une entrée par déclaration. `date` est la date locale de la déclaration ou de la publication.

## Ajouter une citation en trois étapes

### 1. Copier le texte depuis sa source

Ouvrir la source, sélectionner le texte, le copier tel quel. Conserver la ponctuation et la
casse d'origine. Ne pas ajouter de crochets, de coupures ni de « [sic] ».

### 2. Coller une ligne dans `data/quotes.jsonl`

Le fichier est au format JSONL : **une entrée JSON par ligne**, pas de virgule entre les lignes,
pas de tableau englobant. Les lignes vides et celles qui commencent par `#` sont ignorées. Ce
format donne un diff Git d'une ligne par citation, et se modifie directement dans l'éditeur web
de GitHub sans risquer de casser le reste du fichier.

Modèle (toutes les clés obligatoires, dans cet ordre) :

```json
{"id":"trump-2018-09-17-001","author":"trump","date":"2018-09-17","text":"Texte exact copie depuis la source","lang":"en","medium":"twitter","context":"Publication sur le compte @realDonaldTrump","source_url":"https://x.com/realDonaldTrump/status/1041651805821296640","source_type":"archive","verified":true,"added":"2026-09-18","tags":[]}
```

| Champ | Obligatoire | Valeurs |
|---|---|---|
| `id` | oui | `trump-AAAA-MM-JJ-NNN` ou `musk-AAAA-MM-JJ-NNN`, unique ; `NNN` = 001, 002… pour un même auteur et une même date |
| `author` | oui | `trump` ou `musk` |
| `date` | oui | `AAAA-MM-JJ`, date de la déclaration, jamais future |
| `text` | oui | copie exacte, 10 à 1000 caractères |
| `lang` | oui | `en` ou `fr` |
| `text_fr` | non | traduction française ; **exige** alors `translation` |
| `translation` | si `text_fr` | `machine` (traduction automatique, signalée à l'affichage) ou `human` |
| `medium` | oui | `twitter`, `x`, `truth_social`, `speech`, `interview`, `press_conference`, `earnings_call`, `hearing`, `book`, `other` |
| `context` | non | une ligne factuelle, 200 caractères maximum |
| `source_url` | oui | URL `https://` de la source consultée |
| `source_type` | non | `primary` (la source elle-même), `archive` (archive publique), `press` (reprise de presse) |
| `verified` | oui | `true` uniquement après vérification humaine |
| `added` | oui | date d'ajout, `AAAA-MM-JJ` |
| `tags` | non | 8 étiquettes maximum |

`medium` : utiliser `twitter` avant le 24 juillet 2023, `x` après.

### 3. Valider, puis committer

```bash
python3 scripts/validate_quotes.py data/quotes.jsonl
```

Le script vérifie le schéma ligne par ligne, l'unicité des `id`, les dates, les URL, l'absence
de quasi-doublons chez un même auteur, et affiche la couverture des 366 jours. La même commande
tourne en intégration continue sur chaque *pull request* : une entrée `verified: true` sans URL
valide fait échouer la CI.

## Constituer un lot de candidates (pipeline)

Pour couvrir 366 jours, saisir à la main n'a pas d'échelle. Le dépôt fournit une chaîne
semi-automatique où la machine propose et l'humain dispose.

### a. Déposer les archives

Télécharger soi-même les exports d'archives publiques datées et les placer dans `data-sources/`
(dossier ignoré par Git : volume et licences) :

```
data-sources/
├── trump/   export de l'archive publique des tweets @realDonaldTrump (2009 - janvier 2021)
└── musk/    jeu de données de publications d'Elon Musk
```

Formats acceptés : CSV ou JSON, avec détection souple des colonnes (`id`, `text`/`full_text`,
`date`/`created_at`, `favorites`, `retweets`, `isRetweet`). Vérifier la licence de chaque jeu de
données avant de l'utiliser.

### b. Produire les candidates

```bash
python3 scripts/quotes_candidates.py --per-day 5 --min-length 40
```

Le script écarte les repartages, les messages réduits à une URL ou à des mentions, les textes
trop courts et les quasi-doublons (y compris ceux déjà présents dans `data/quotes.jsonl`), note
chaque message par un engagement **normalisé par année** — les volumes de 2012 et de 2020 ne
sont pas comparables —, retient les N meilleurs par jour calendaire et par auteur, et écrit
`data/quotes.candidates.jsonl` avec `verified: false`. Il affiche en fin d'exécution la liste
des jours sans candidat.

Ce fichier **n'est jamais affiché par l'application**.

### c. Vérifier une par une

Ouvrir `tools/review.html` (par le sélecteur de fichier, ou en servant le dossier). La page
affiche les candidates jour par jour avec leur lien source, permet de marquer « vérifié », de
saisir le contexte et la traduction, puis exporte les lignes retenues à coller dans
`data/quotes.jsonl`. Rien n'est écrit sur un serveur : l'export est un téléchargement.

Raccourcis : `j`/`k` ou ↑/↓ pour naviguer, `v` vérifier, `r` rejeter, `o` ouvrir la source.

## Contribuer au code

- Code en anglais (identifiants et commentaires), interface et messages en français.
- Fonctions pures séparées du DOM, testées : `npm test` et `npm run test:py` doivent rester au vert.
- Toute modification d'un format de données passe par `DATA_FORMATS.md`, et par **les deux**
  implémentations (Python et JavaScript) plus leurs tests : la fixture commune
  `tests/fixtures/synthetic_climatology_expected.json` garantit qu'elles restent identiques.
- Aucune constante climatique dans le code : tout vient de `data/baselines.json`.
- Aucun nouveau domaine réseau sans mise à jour de la `Content-Security-Policy` d'`index.html`
  et de la liste de `scripts/check_sources.mjs`.
- Aucune dépendance à l'exécution : pas de CDN, pas de framework, pas d'étape de compilation.
