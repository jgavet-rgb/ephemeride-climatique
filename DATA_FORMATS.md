# Formats de données et algorithmes partagés

Ce document est le contrat entre les scripts Python (`scripts/`), le code client
(`assets/js/`) et les fichiers de `data/`. Toute modification de format incrémente
`schema_version` et met à jour les deux implémentations et leurs tests.

Conventions générales :

- Dates civiles au format ISO `AAAA-MM-JJ` ; horodatages en UTC ISO 8601 (`...Z`).
- Températures en degrés Celsius. Les séries journalières sont stockées en dixièmes de
  degré, entiers (`218` = 21,8 °C), `null` si absent.
- Arrondi commun à deux décimales : `round2(x) = floor(x * 100 + 0.5) / 100`.
  Même formule en JS (`Math.floor`) et en Python (`math.floor`). Aucune autre méthode
  d'arrondi n'est utilisée dans les calculs partagés.
- Clés calendaires : 366 clés `MM-JJ`, dans l'ordre du calendrier d'une année
  bissextile (`01-01` … `02-28`, `02-29`, `03-01` … `12-31`). `02-29` est à l'index 59.
  Une année non bissextile a `null` à l'index 59.

## 1. `data/climatology/<slug>.json`

Produit par `scripts/build_climatology.py` (GitHub Action quotidienne) ou, pour un
lieu non précalculé, reconstruit côté client par `assets/js/climate.js` à partir de
l'API d'archive Open-Meteo. Les deux implémentations produisent exactement la même
structure et les mêmes valeurs pour les mêmes entrées.

```json
{
  "schema_version": 1,
  "location": {
    "slug": "grenoble", "label": "Grenoble", "lat": 45.1885, "lon": 5.7245,
    "timezone": "Europe/Paris", "country_code": "FR", "elevation": 212,
    "berkeley_region": "france"
  },
  "source": {
    "provider": "Open-Meteo", "endpoint": "https://archive-api.open-meteo.com/v1/archive",
    "model": "era5", "dataset": "ERA5 (ECMWF, Copernicus Climate Change Service)",
    "grid_lat": 45.25, "grid_lon": 5.75, "grid_elevation": 214.0,
    "fetched_at": "2026-09-17T06:30:00Z", "start": "1940-01-01", "end": "2026-09-11",
    "variable": "temperature_2m_mean"
  },
  "normal_period": [1991, 2020],
  "window_days": 7,
  "keys": ["01-01", "01-02", "…", "12-31"],
  "normal_mean": [1.23, 1.19, "…"],
  "normal_std": [3.41, 3.4, "…"],
  "records": {
    "max": [[12.4, 2007], "…"],
    "min": [[-9.8, 1985], "…"]
  },
  "annual": [
    { "year": 1940, "mean": 10.23, "anomaly": -0.41, "days": 366, "partial": false },
    { "year": 2026, "mean": 13.1, "anomaly": 1.35, "days": 254, "partial": true }
  ],
  "daily": {
    "1940": [12, 8, null, "… 366 entrées"],
    "1941": ["…"]
  }
}
```

### 1.1 Entrée

Réponse de `GET https://archive-api.open-meteo.com/v1/archive` avec
`latitude`, `longitude`, `start_date=1940-01-01`, `end_date` = aujourd'hui − 6 jours,
`daily=temperature_2m_mean`, `timezone=auto`, `models=era5`. Champs utilisés :
`daily.time[]` (dates ISO) et `daily.temperature_2m_mean[]` (nombres ou `null`),
`latitude`, `longitude`, `elevation` (point de grille effectivement utilisé).

Vérifié le 17/09/2026 sur une requête réelle : la réponse contient bien
`daily.time`, `daily.temperature_2m_mean`, `timezone`, `elevation`.

### 1.2 Algorithme (identique en JS et en Python)

1. `daily[year][idx] = floor(v * 10 + 0.5)` pour v ≥ 0, `-floor(-v * 10 + 0.5)` pour
   v < 0 (arrondi « demi vers l'extérieur » en dixièmes) ; `null` si la valeur manque.
   Chaque année présente dans la série a un tableau de 366 entrées.
2. Normale, pour chaque index `i` (0…365) :
   `V = { daily[y][j] / 10 : y ∈ [1991, 2020], j = (i + k) mod 366, k ∈ [−7, 7], daily[y][j] ≠ null }`.
   `normal_mean[i] = round2(moyenne(V))`, `normal_std[i] = round2(écart-type population de V)`
   (diviseur `n`, pas `n − 1`). Si `V` est vide (série trop courte), `null` pour les deux.
3. Anomalie d'une valeur `v` (°C) au jour `i` : `v − normal_mean[i]` (non arrondie en interne,
   `round2` à l'affichage).
4. `annual` : pour chaque année `y` présente, sur les jours non nuls :
   `mean = round2(moyenne(daily[y][idx] / 10))`,
   `anomaly = round2(moyenne(daily[y][idx] / 10 − normal_mean[idx]))` (jours dont la normale
   est `null` exclus), `days` = nombre de jours non nuls, `partial = days < 360`.
   Années triées croissantes.
5. `records` : pour chaque index `i`, sur toutes les années où `daily[y][i] ≠ null` :
   `max = [valeur/10, première année atteignant ce maximum]`, idem `min`.
   `[null, null]` si aucune valeur.
6. Rang chaud (client uniquement) d'une valeur `v` au jour `i` :
   `rank = 1 + nombre d'années avec daily[y][i] / 10 > v`, `n` = nombre d'années non nulles.

### 1.3 Fixture partagée

`tests/fixtures/synthetic_series.json` : `{ "time": [...], "temperature_2m_mean": [...] }`
sur la période 1989-01-01 → 2024-03-15, série déterministe (sinusoïde annuelle + tendance +
bruit pseudo-aléatoire à graine fixe, quelques `null`). `tests/fixtures/synthetic_climatology_expected.json` :
sortie attendue (sections `keys`, `normal_mean`, `normal_std`, `records`, `annual`, `daily`).
La suite Python et la suite Node vérifient toutes deux l'égalité stricte avec cette sortie.

## 2. `data/baselines.json`

Produit par `scripts/build_baselines.py`. Unique origine autorisée d'une constante
climatique dans l'application : aucun chiffre de réchauffement n'est écrit dans le code.

```json
{
  "schema_version": 1,
  "generated_at": "2026-09-17T06:35:00Z",
  "method": "delta_c = moyenne des anomalies annuelles 1991-2020 - moyenne des anomalies annuelles 1850-1900 ; anomalie annuelle = moyenne des 12 anomalies mensuelles (>= 10 mois valides) ; chaque fenetre exige >= 25 annees valides",
  "regions": {
    "france": {
      "label": "France",
      "delta_c": 1.85,
      "pre_window": [1850, 1900], "ref_window": [1991, 2020],
      "n_pre": 51, "n_ref": 30,
      "anomaly_base": "1951-1980",
      "source_url": "https://berkeley-earth-temperature.s3.us-west-1.amazonaws.com/Regional/TAVG/france-TAVG-Trend.txt",
      "attribution": "Berkeley Earth (berkeleyearth.org)", "licence": "CC BY-NC 4.0",
      "analysis_date": "06-Jan-2021", "fetched_at": "2026-09-17T06:35:00Z",
      "fallback_from": null, "note": null
    }
  }
}
```

`delta_c` vaut `null` (et `note` explique pourquoi) quand aucune source de la chaîne
de repli n'a fourni assez d'années valides. Le client affiche alors « indisponible ».

### 2.1 Fichiers Berkeley Earth (`*-TAVG-Trend.txt`)

Format texte : lignes de commentaire commençant par `%` ; puis, par ligne, 12 colonnes
séparées par des espaces : `année, mois, anomalie mensuelle, incertitude, anomalie annuelle
(moyenne mobile 12 mois centrée), inc., 5 ans, inc., 10 ans, inc., 20 ans, inc.`, valeurs
manquantes `NaN`. Anomalies relatives à la moyenne janvier 1951-décembre 1980. L'en-tête
contient la ligne `% This analysis was run on <date>` (→ `analysis_date`) et
`%%  Estimated Jan 1951-Dec 1980 absolute temperature (C): <valeur> +/- <inc.>`.

Seule la colonne 3 (anomalie mensuelle) est utilisée : anomalie annuelle d'une année =
moyenne des mois non `NaN` si au moins 10 mois valides, sinon année invalide.

Chaîne de repli par lieu : `berkeley_region` → `berkeley_fallback` (continent, ex. `europe`)
→ série mondiale terres `https://berkeley-earth-temperature.s3.us-west-1.amazonaws.com/Global/Complete_TAVG_complete.txt`
(même format). Le repli utilisé est consigné dans `fallback_from`.

## 3. `data/locations.json`

```json
{
  "schema_version": 1,
  "locations": [
    {
      "slug": "grenoble", "label": "Grenoble", "admin1": "Auvergne-Rhône-Alpes", "country": "France",
      "lat": 45.1885, "lon": 5.7245, "timezone": "Europe/Paris", "country_code": "FR",
      "elevation": 212, "berkeley_region": "france", "berkeley_fallback": "europe",
      "geocoding_source": "https://geocoding-api.open-meteo.com/v1/search?name=Grenoble&count=1&language=fr&format=json"
    }
  ]
}
```

Le premier lieu est le lieu par défaut. `slug` : minuscules, chiffres, tirets. Ajouter un
lieu = ajouter un objet ; l'Action produit `data/climatology/<slug>.json` au prochain cycle
et `build_baselines.py` complète `baselines.json` si la région est nouvelle.

## 4. `data/quotes.jsonl`

Une entrée JSON par ligne. Lignes vides et lignes commençant par `#` ignorées. Schéma
complet dans `data/quotes.schema.json` (JSON Schema 2020-12, appliqué à chaque ligne).
Champs obligatoires : `id`, `author`, `date`, `text`, `lang`, `medium`, `source_url`,
`verified`, `added`. Seules les entrées `verified: true` sont affichées.

`id` : `^(trump|musk|exemple)-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{3}$`, unique.
`text_fr` exige `translation` (`machine` ou `human`).

`data/quotes.candidates.jsonl` : même format, sortie de `scripts/quotes_candidates.py`,
jamais chargé par l'application.

### 4.1 Sélection côté client

`candidates = verified ∧ MM-JJ(date) = MM-JJ(cible) ∧ auteur ∈ filtre`, triées par `id`.
`index = fnv1a32(cible_ISO + "|" + filtre) mod n`. Replis : tous auteurs, puis ± 1, ± 2, ± 3
jours (`MM-JJ` décalés dans une année bissextile de référence), chaque repli signalé.

## 5. `data/saints.json`

```json
{
  "_source": "…", "_licence": "…", "_note": "…",
  "days": { "01-01": { "saint": "Marie, Mère de Dieu", "names": ["Marie"] }, "…": {} }
}
```

366 clés obligatoires, `saint` non vide. `names` : prénoms fêtés (peut être vide).

## 6. `data/republican.json`

```json
{
  "_source": "…", "_licence": "…",
  "months": ["Vendémiaire", "Brumaire", "Frimaire", "Nivôse", "Pluviôse", "Ventôse",
             "Germinal", "Floréal", "Prairial", "Messidor", "Thermidor", "Fructidor"],
  "days": ["Raisin", "Safran", "… 360 noms dans l'ordre"],
  "complementary": ["Vertu", "Génie", "Travail", "Opinion", "Récompenses", "Révolution"],
  "decade_days": ["Primidi", "Duodi", "Tridi", "Quartidi", "Quintidi", "Sextidi", "Septidi", "Octidi", "Nonidi", "Décadi"]
}
```

Conversion (`assets/js/republican.js`), méthode de Romme :

- Années sextiles (366 jours, 6 sansculottides) : les ans III, VII, XI et XV (règle
  historique de l'équinoxe, appliquée jusqu'à l'an XIX), puis à partir de l'an XX la règle
  grégorienne appliquée au numéro d'an : `N mod 4 = 0`, sauf `N mod 100 = 0` à moins que
  `N mod 400 = 0`.
- Le 1er vendémiaire de l'an `N` tombe le jour grégorien
  `22 septembre 1792 + 365 × (N − 1) + S(N − 1)` où `S(k)` = nombre d'ans sextiles parmi
  1…k. La conversion d'une date grégorienne cherche le plus grand `N` dont le 1er vendémiaire
  est ≤ à la date, puis `mois = (rang − 1) div 30 + 1` (13 = sansculottides), `jour = (rang − 1) mod 30 + 1`.
- Tests : 22/09/1792 = 1 vendémiaire an I ; 27/07/1794 = 9 thermidor an II ;
  23/09/1795 = 1 vendémiaire an IV ; 09/11/1799 = 18 brumaire an VIII ;
  24/09/1803 = 1 vendémiaire an XII ; 01/01/1806 = 11 nivôse an XIV.
  Le choix de la règle de continuation est consigné dans `DECISIONS.md`.
