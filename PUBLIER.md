# Publier le dépôt et le site

Procédure complète, de ce dossier à une URL en ligne. Compter dix minutes, dont sept d'attente
du premier déploiement.

Le dépôt Git est **déjà initialisé** dans ce dossier, sur la branche `main`, avec les 66 fichiers
indexés et les exclusions vérifiées (ni `node_modules`, ni `data-sources/`, ni caches Python).
Il ne reste que l'identité, le commit, le dépôt distant et la publication.

## 1. Créer le dépôt vide sur GitHub

Sur <https://github.com/new> :

| Champ | Valeur |
|---|---|
| Repository name | `ephemeride-climatique` |
| Description | Calendrier perpétuel : éphéméride, citation datée, météo et climate stripes |
| Visibilité | **Public** (obligatoire pour Pages et Actions gratuits) |
| Add a README file | **décoché** |
| Add .gitignore | **None** |
| Choose a license | **None** |

Les trois dernières cases doivent rester vides : le dépôt local apporte déjà ces fichiers, et un
dépôt distant non vide provoquerait un conflit au premier `push`.

## 2. Premier commit et envoi

Dans PowerShell, depuis ce dossier, en remplaçant les deux valeurs de la première ligne :

```powershell
git config user.email "votre.adresse@exemple.fr"     # visible publiquement et définitivement
git commit -m "feat: calendrier perpetuel, ephemeride, citations datees et climate stripes"
git remote add origin https://github.com/VOTRE-PSEUDO/ephemeride-climatique.git
git push -u origin main
```

Au `push`, le gestionnaire d'identifiants Windows ouvre une fenêtre de connexion GitHub :
s'authentifier dans cette fenêtre, jamais en collant un jeton dans le terminal.

Vérifier ensuite sur la page du dépôt que les trois workflows apparaissent dans l'onglet
**Actions** et que `Validation` passe au vert (environ deux minutes : tests JavaScript et Python,
validation des données, contrôle des sources).

## 3. Activer GitHub Pages

*Settings → Pages → Build and deployment → Source* : choisir **GitHub Actions**.

Le workflow `pages.yml` se déclenche alors seul, ou par *Actions → Deploiement GitHub Pages →
Run workflow*. Une fois vert, le site est à :

```
https://VOTRE-PSEUDO.github.io/ephemeride-climatique/
```

Variante sans Actions : *Source → Deploy from a branch*, branche `main`, dossier `/ (root)`.
Le résultat est identique ; le workflow `pages.yml` devient alors inutile et peut être supprimé.

## 4. Autoriser l'écriture du rafraîchissement quotidien

`data-refresh.yml` committe les fichiers de `data/` qu'il met à jour. Il lui faut le droit
d'écriture : *Settings → Actions → General → Workflow permissions* → **Read and write
permissions**, puis *Save*.

Sans cela, le workflow s'exécute mais échoue au `git push` avec « permission denied ».

## 5. Vérifier

Une fois le site en ligne, contrôler dans l'ordre :

1. la page s'ouvre sur la date du jour à Grenoble, les trois blocs sont présents ;
2. le bloc C affiche la météo, puis les deux séries de bandes colorées ;
3. le bloc B affiche l'état vide documenté (normal : `data/quotes.jsonl` ne contient encore que
   la ligne d'exemple, non vérifiée) ;
4. `#/j/1976-07-04` donne une température observée ERA5 et son écart ;
5. `#/m/2026-09` colore la grille du mois ; `#/a/1976` affiche la heatmap ;
6. un clic sur une bande d'année ouvre la même date de cette année-là ;
7. onglet Réseau du navigateur : seuls `open-meteo.com` et le domaine `github.io` sont contactés ;
8. le lendemain matin, l'onglet Actions montre un `data: refresh climatology <date>` si ERA5 a
   publié de nouveaux jours.

## 6. Ensuite

- **Remplir la base de citations** : voir `CONTRIBUTING.md`. C'est le seul travail restant pour
  que le bloc B s'anime, et il demande des archives que vous téléchargez vous-même.
- **Ajouter une ville** : une ligne dans `data/locations.json`, le rafraîchissement quotidien
  produit sa climatologie (`README.md`).
- **Développer** : `npm install` puis `npm test`, `npm run test:py`, `npm run validate`,
  `npm run check`. La CI rejoue exactement ces quatre commandes.

## Dépannage

| Symptôme | Cause et remède |
|---|---|
| `failed to push some refs` | Le dépôt distant n'est pas vide. `git pull --rebase origin main` puis repousser, ou recréer le dépôt sans README ni licence. |
| Page blanche, console « Failed to load module script » | Le site est ouvert en `file://`. Les modules ES exigent HTTP : `python3 -m http.server 8000`. |
| 404 sur `data/...json` en local | Serveur lancé depuis le mauvais dossier : se placer à la racine du dépôt. |
| Actions désactivées | *Settings → Actions → General → Allow all actions*. |
| `data-refresh` échoue au push | Étape 4 non faite (droits d'écriture des workflows). |
| Le site ne se met pas à jour après un push | Le déploiement Pages prend une à deux minutes ; vider le cache du navigateur. |
| Blocs météo vides, console CSP | Un domaine a été ajouté dans le code sans être déclaré dans la `Content-Security-Policy` d'`index.html` ni dans `scripts/check_sources.mjs`. |

## Ce que la publication rend public

Tout : le code, les données, l'historique des commits et l'adresse e-mail qu'ils portent. Le
contenu a été vérifié pour ne comporter aucune donnée d'entreprise, mais l'adresse e-mail du
commit, elle, restera dans l'historique et n'est pas effaçable simplement. C'est le choix fait à
l'étape 2.
