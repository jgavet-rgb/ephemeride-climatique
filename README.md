# Éphéméride climatique

Calendrier perpétuel web, statique, hébergé sur GitHub Pages. Pour n'importe quelle date et
n'importe quel lieu, une seule page réunit trois blocs :

- **A - la journée** : lever et coucher du soleil, durée du jour et sa variation, phase de lune,
  saint du jour et prénoms fêtés, jours fériés et fêtes françaises, saison et prochain solstice
  ou équinoxe, calendrier républicain (date, nom du jour, décade), numérotation du jour et
  semaine ISO ;
- **B - une citation datée** de Donald Trump ou d'Elon Musk prononcée ou publiée le même jour de
  l'année, tirée d'une base indépendante et facilement actualisable, toujours avec sa source ;
- **C - la météo et le climat** : conditions du jour, puis l'écart à la normale de saison
  1991-2020 et l'écart estimé à l'époque pré-industrielle 1850-1900, en « climate stripes ».

Trois vues : **Jour**, **Mois** (grille colorée par l'écart journalier) et **Année** (heatmap
12 × 31). Un clic sur une bande d'une année ouvre la même date de cette année-là : c'est ce qui
rend le calendrier réellement perpétuel.

## Démarrage

L'application est un site statique sans étape de compilation : HTML, CSS et modules ES natifs.

```bash
git clone <url-du-depot> && cd ephemeride-climatique
python3 -m http.server 8000     # ou npm run serve
# puis ouvrir http://localhost:8000/
```

Ouvrir `index.html` directement par `file://` ne fonctionne pas : les modules ES et le
chargement des fichiers de `data/` exigent le protocole HTTP.

### Publication sur GitHub Pages

Le dépôt se publie tel quel depuis la racine de `main`. Deux possibilités :

1. le workflow `.github/workflows/pages.yml` (GitHub Actions), actif dès que Pages est réglé
   sur « GitHub Actions » dans *Settings → Pages* ;
2. ou, plus simple encore, *Settings → Pages → Deploy from a branch*, branche `main`, dossier
   `/ (root)`.

Le routage se fait par le fragment d'URL (`#/j/2026-09-17`), jamais par le chemin : le site
fonctionne donc sous `https://<compte>.github.io/<depot>/` sans configuration de serveur.

### URL partageables

| Forme | Effet |
|---|---|
| `#/j/2026-09-17` | vue Jour |
| `#/m/2026-09` | vue Mois |
| `#/a/1976` | vue Année |
| `…?lieu=grenoble` | lieu précalculé, par son `slug` |
| `…?lieu=45.1787,5.7148` | lieu quelconque, par coordonnées |

Les flèches ← et → naviguent, la touche `t` revient à aujourd'hui.

## Ce que fait l'application, et ce qu'elle ne fait pas

- Aucune clé d'API, aucun secret, aucun backend, aucun proxy. Les seuls appels réseau vont à
  Open-Meteo (prévision, archive, géocodage) et aux fichiers du dépôt. La `Content-Security-Policy`
  de `index.html` le verrouille, et la CI le vérifie (`scripts/check_sources.mjs`).
- Aucun suivi, aucune analytique, aucun cookie. `localStorage` et IndexedDB servent uniquement
  aux préférences et au cache, toujours sous `try/catch`.
- Chaque bloc est indépendant : réseau coupé, l'éphéméride et la citation restent affichées et
  seuls les blocs météo signalent l'indisponibilité.
- **Aucune donnée inventée.** Un chiffre climatique affiché provient d'un calcul sur des données
  téléchargées dont la provenance est enregistrée ; une citation affichée provient d'une entrée
  `verified: true` portant une URL source. À défaut : « indisponible » et la raison.

## Données

| Fichier | Rôle | Origine |
|---|---|---|
| `data/quotes.jsonl` | base de citations, **une ligne par citation** | contributions humaines vérifiées |
| `data/quotes.schema.json` | schéma JSON de validation | ce dépôt |
| `data/saints.json` | 366 jours : saint, prénoms fêtés, fête liturgique | Wikipédia (CC BY-SA 4.0) |
| `data/republican.json` | mois, 360 noms de jours, sansculottides, décadis | Wikipédia (CC BY-SA 4.0) |
| `data/locations.json` | lieux précalculés (le premier est le lieu par défaut) | géocodage Open-Meteo / GeoNames |
| `data/climatology/<slug>.json` | normales, records, séries journalières depuis 1940 | **généré** : ERA5 via Open-Meteo |
| `data/baselines.json` | écart pré-industriel Δ par région, avec sa provenance | **généré** : Berkeley Earth |

Les formats sont spécifiés dans [`DATA_FORMATS.md`](DATA_FORMATS.md), qui fait contrat entre les
scripts Python et le code JavaScript : les deux implémentations produisent les mêmes valeurs,
au bit près, et une fixture commune le vérifie dans les deux suites de tests.

### Ajouter une ville

Ajouter un objet dans `data/locations.json` (voir `DATA_FORMATS.md` § 3), puis attendre le
rafraîchissement quotidien, ou lancer localement :

```bash
python3 scripts/build_climatology.py --slug ma-ville
python3 scripts/build_baselines.py          # si la région Berkeley Earth est nouvelle
```

Un lieu absent de cette liste reste utilisable : l'application calcule alors sa climatologie
côté navigateur depuis l'API d'archive et la met en cache dans IndexedDB.

### Ajouter une citation

Voir [`CONTRIBUTING.md`](CONTRIBUTING.md). En trois étapes : copier le texte exact depuis sa
source, coller une ligne dans `data/quotes.jsonl` en suivant le modèle en tête de fichier,
committer. La CI valide la ligne et la citation apparaît au prochain chargement.

## Méthode climatique, en bref

- **Normale de saison** : pour chaque jour calendaire, moyenne des températures moyennes
  journalières ERA5 des 30 années 1991-2020 dans une fenêtre centrée de ± 7 jours, soit
  450 valeurs, ce qui lisse le bruit journalier.
- **Anomalie du jour** = moyenne journalière − normale de ce jour calendaire.
- **Écart au pré-industriel** = anomalie du jour + Δ, où Δ est la différence entre la moyenne
  des anomalies annuelles 1991-2020 et celle des anomalies annuelles 1850-1900 dans la série
  nationale Berkeley Earth du pays du lieu. Approximation assumée, indiquée dans l'application :
  un Δ annuel appliqué à une valeur journalière ignore la saisonnalité du réchauffement.
- **Aucune constante climatique n'est écrite dans le code.** Toute valeur de réchauffement vient
  de `data/baselines.json`, qui porte pour chaque région son URL source, ses fenêtres, son nombre
  d'années valides et sa date de récupération. `scripts/check_sources.mjs` fait échouer la CI si
  une constante réapparaît dans `assets/js/`.
- **Sources de température du jour** : ERA5 jusqu'à J−6 (« observé »), prévision `past_days`
  pour les jours plus récents (« observé, provisoire »), prévision jusqu'à J+16 (« prévu »),
  rien au-delà ni avant 1940 (« hors données », normale et records seulement).

## Développement

```bash
npm install                 # jsdom, uniquement pour les tests
npm test                    # tests JavaScript (node:test)
npm run test:py             # tests Python (unittest)
npm run validate            # validation des citations et des fichiers de données
npm run check               # aucune constante climatique, aucun domaine imprévu
```

Arborescence :

```
index.html               application (une page)
assets/css/app.css       thème clair/sombre, mobile first
assets/js/               dates, astro, republican, quotes, weather, climate,
                         stripes, storage, ui, views/{day,month,year}, app
data/                    voir le tableau ci-dessus
scripts/                 Python : build_climatology, build_baselines,
                         quotes_candidates, validate_quotes, validate_data
tools/review.html        page locale de curation des citations candidates
tests/js, tests/python   suites de tests et fixtures partagées
.github/workflows/       validate, pages, data-refresh
```

### Automatisations

| Workflow | Déclenchement | Effet |
|---|---|---|
| `validate.yml` | push, pull request | tests JS et Python, validation des données, contrôle des sources |
| `data-refresh.yml` | cron 06:30 UTC, manuel | met à jour `data/climatology/*` (incrémental) et, le lundi, `data/baselines.json` ; ne committe que si un fichier a changé |
| `pages.yml` | push sur `main` | déploie le site |

`data-refresh.yml` n'a besoin d'aucun secret : le jeton par défaut du workflow suffit.

## Licences et attributions

Le **code** est sous licence MIT. Les **données** ont leurs propres conditions, détaillées dans
[`LICENSE`](LICENSE) : Open-Meteo (usage non commercial ; données ERA5 du Copernicus Climate
Change Service / ECMWF), Berkeley Earth (CC BY-NC 4.0), GeoNames, Wikipédia (CC BY-SA 4.0).
L'ensemble impose en pratique un usage non commercial.

Les citations sont reproduites à fins d'information et de documentation, avec leur source et
sans commentaire éditorial, sans affiliation avec les personnes citées.
