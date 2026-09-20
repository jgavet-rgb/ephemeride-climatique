# Décisions

Une ligne par décision : date, décision, alternative écartée, raison. Ajout seul.

## 2026-09-18 - Nom de l'application

« Éphéméride climatique ». Écarté : « Calendrier perpétuel climatique » (long), « Stripes du
jour » (ne dit pas l'éphéméride). Le nom tient dans une barre de titre et annonce les deux
moitiés du produit.

## 2026-09-18 - Racine du dépôt plutôt que `docs/`

Le site est publié depuis la racine de `main`. Écarté : `docs/`, qui aurait imposé de dupliquer
ou de déplacer `data/` et `assets/`. Conséquence assumée : les fichiers de développement
(`tests/`, `scripts/`, `package.json`) sont servis par Pages ; ils sont inertes et publics de
toute façon puisque le dépôt l'est.

## 2026-09-18 - Format JSONL pour les citations

`data/quotes.jsonl`, une entrée JSON par ligne. Écarté : un tableau JSON classique (une virgule
oubliée casse tout le fichier, et le diff Git d'un ajout touche deux lignes), un fichier par
citation (des milliers de fichiers), SQLite (illisible en revue de code). Le JSONL donne un diff
d'une ligne par citation et se modifie dans l'éditeur web de GitHub sans outil.

## 2026-09-18 - Le texte d'une citation n'est jamais rédigé

Seules les entrées `verified: true`, portant une `source_url`, sont affichées ; le champ `text`
est une copie de la source. Écarté : pré-remplir les textes depuis une connaissance générale,
qui produit des citations plausibles mais fausses attribuées à des personnes réelles. Le
pipeline `quotes_candidates.py` ne fait que sélectionner des messages existants dans des
archives déposées par le mainteneur ; la vérification reste humaine.

## 2026-09-18 - Normale de saison sur une fenêtre de ± 7 jours

Normale 1991-2020 calculée sur une fenêtre centrée de ± 7 jours, soit 450 valeurs par jour
calendaire. Écarté : la moyenne des 30 valeurs du seul jour calendaire, trop bruitée (l'écart
type d'un échantillon de 30 valeurs journalières donne des « normales » en dents de scie de
plusieurs dixièmes d'un jour à l'autre). Conséquence : la normale est lissée, l'anomalie d'un
jour isolé est plus stable et comparable d'un jour à l'autre.

## 2026-09-18 - Écart pré-industriel = anomalie du jour + Δ régional annuel

Δ vient de la série nationale Berkeley Earth (moyenne des anomalies annuelles 1991-2020 moins
moyenne des anomalies annuelles 1850-1900), calculé par `build_baselines.py` et stocké avec sa
provenance dans `data/baselines.json`. Écarté : une valeur globale unique codée dans le code
(fausse localement et invérifiable), et une reconstruction journalière pré-industrielle locale
(aucune donnée journalière ne remonte à 1850 pour une ville). L'approximation — un Δ annuel
appliqué à une valeur journalière, qui ignore la saisonnalité du réchauffement — est affichée
dans la modale « Méthode et sources ». Si Δ manque, la ligne affiche « indisponible » et la
raison, jamais une valeur par défaut.

## 2026-09-18 - Aucune constante climatique dans le code

Toute valeur de réchauffement vient de `data/baselines.json`. `scripts/check_sources.mjs` fait
échouer la CI si un nombre décimal associé au vocabulaire du réchauffement réapparaît dans
`assets/js/`, et vérifie au passage qu'aucun domaine réseau imprévu n'y figure. Écarté : la
simple relecture, qui laisse passer une constante « provisoire » au bout de six mois.

## 2026-09-18 - Contrat numérique partagé entre Python et JavaScript

`DATA_FORMATS.md` fixe l'ordre d'itération, l'accumulation en virgule flottante, l'écart type
population et l'arrondi `floor(x * 100 + 0.5) / 100`. Les deux implémentations sont vérifiées
contre la même fixture (`tests/fixtures/synthetic_series.json` →
`synthetic_climatology_expected.json`), avec une égalité stricte. Écarté : « les deux calculent
la même chose, à l'arrondi près », qui aurait fait diverger un fichier précalculé par l'Action
et le même fichier recalculé dans le navigateur, et rendu tout diff illisible.

## 2026-09-18 - Modèle ERA5 fixé explicitement dans l'URL d'archive

`models=era5` plutôt que le `best_match` par défaut, qui mélange ERA5, ERA5-Land et IFS 9 km
selon la période. Écarté : la résolution plus fine d'IFS après 2017, qui aurait introduit une
rupture de série au milieu de la période et faussé la comparaison d'une année à l'autre.
Conséquence : la valeur d'un jour récent peut différer de quelques dixièmes de celle d'un
service météo local.

## 2026-09-18 - Palette et bornes fixes

Palette divergente de type ColorBrewer RdBu à 11 classes, symétrique autour du zéro choisi,
bornes fixes : ± 2,5 °C pour les écarts annuels, ± 8 °C pour les écarts journaliers. Écarté :
une échelle adaptée aux données affichées, qui aurait rendu deux lieux ou deux périodes
incomparables et exagéré visuellement les variations d'un lieu peu contrasté.

## 2026-09-18 - Calendrier républicain : continuation Romme

Ans sextiles III, VII, XI, XV par la règle historique de l'équinoxe, puis règle grégorienne
appliquée au numéro d'an à partir de l'an XX (article X, système Romme). Écarté : la règle de
l'équinoxe vrai (article III, Delambre puis IMCCE), qui décale d'un jour certaines années et
exige un calcul d'équinoxe pour chaque an. La concordance a été vérifiée contre la table
2026-2050 de la source : 1er vendémiaire an CCXXXV = 22 septembre 2026. Le choix est documenté
dans `data/republican.json` (`_rule`).

## 2026-09-18 - Astronomie recalculée localement, pas d'API

Soleil, lune et saisons sont calculés dans le navigateur (algorithmes publiés : NOAA pour le
soleil, Meeus chapitres 27 et 49 pour les saisons et les phases). Écarté : les champs `sunrise`
et `sunset` d'Open-Meteo, qui n'existent que pour les dates couvertes par l'API et auraient
privé la vue Jour de sa substance hors de cette fenêtre. Les valeurs calculées ont été
comparées aux valeurs de l'API sur plusieurs lieux et saisons : écart inférieur à une minute.

## 2026-09-18 - Trois vues et un routage par fragment

Jour, Mois, Année ; URL `#/j/…`, `#/m/…`, `#/a/…` avec un paramètre `?lieu=`. Écarté : un
routage par chemin, qui exige une réécriture serveur impossible sur Pages. Conséquence :
les URL sont partageables et le bouton « retour » du navigateur fonctionne.

## 2026-09-18 - Vue Année conservée en v1

Prévue en option, elle a été implémentée : la heatmap 12 × 31 réutilise le calcul de la vue Mois
et coûte un seul fichier. Écarté : la reporter, ce qui aurait laissé un trou entre le mois et la
série annuelle.

## 2026-09-18 - Point ouvert : Δ pré-industriel pour un lieu hors région configurée

Un lieu dont le pays n'a pas de `berkeley_region` dans `data/locations.json` affiche
« indisponible » pour l'écart pré-industriel. La chaîne de repli (pays → continent → terres
mondiales) existe dans `build_baselines.py` mais n'est déclenchée que pour les régions
référencées. À trancher : rattacher automatiquement un pays à sa série Berkeley Earth par son
code ISO, au prix d'une table de correspondance à maintenir.

## 2026-09-18 - Point ouvert : indicateur « planète »

L'écart de la température mondiale du jour au pré-industriel n'est pas implémenté : aucune
source de données journalières mondiales, téléchargeable et documentée, n'a été identifiée avec
certitude dans le temps imparti. À reprendre si une telle source est confirmée.
