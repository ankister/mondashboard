# Mon dashboard

Dashboard modulaire et auto-hébergé : supervision des machines (CPU, RAM, réseau, GPU, SMART, mises à jour), conteneurs Docker de toutes les machines, activité Plex et Jellyfin, torrents qBittorrent (avec ajout), calendriers CalDAV (Nextcloud, Infomaniak) et Home Assistant, météo, flux FreshRSS et favoris avec statut en ligne / hors ligne.

Tout se configure depuis l'interface : onglets, widgets (glisser-déposer, largeur), intégrations et favoris. Aucun fichier YAML à éditer.

---

## 1. Tester sur ton PC

### Option A : Docker (recommandé)

```bash
cd homedash
docker compose up -d --build
```

Ouvre ensuite **http://localhost:3080**.

### Option B : Node.js (version 20 ou plus)

```bash
cd homedash
npm install
DEMO=1 npm start
```

### Premier lancement

1. Crée le compte administrateur (8 caractères minimum pour le mot de passe).
2. Avec `DEMO=1`, quatre onglets de démonstration sont créés (Accueil, Serveurs, Docker, Médias). Ils sont branchés sur une intégration « Démo » qui produit des données fictives.
3. Les favoris de démo pointent vers des adresses d'exemple (192.168.1.10, etc.) : remplace-les par les tiennes dans la configuration du widget.

**Repartir de zéro :** `docker compose down -v` (Docker) ou supprime le dossier `data/` (Node). Sans `DEMO=1`, la base démarre avec un seul onglet vide.

---

## 2. Utilisation

| Action | Où |
|---|---|
| Ajouter, renommer ou supprimer un onglet | **✎ Modifier**, puis « ＋ Onglet », ou le ✎ sur l'onglet actif |
| Réordonner les onglets | Mode Modifier : glisser un onglet sur un autre |
| Ajouter un widget | Mode Modifier : « ＋ Ajouter un widget » |
| Déplacer un widget | Mode Modifier : glisser la poignée ⠿ n'importe où dans la grille (les blocs se réorganisent automatiquement). Pour l'envoyer dans un autre onglet : ⚙ → Onglet |
| Taille d'un widget | Mode Modifier : tirer un bord ou un coin du bloc, ou utiliser les sélecteurs de largeur (2/12 à 12/12) et de hauteur. « Auto » = hauteur adaptée au contenu |
| Calendrier | Boutons « Liste » / « Mois » en haut du widget ; en vue mensuelle, ▲ ▼ changent de mois, ● revient à aujourd'hui, un clic sur un jour affiche ses événements |
| Notes Markdown | Widget « Notes (Markdown) » : ✎ pour écrire (Ctrl+S enregistre, Échap annule), onglet Aperçu ; les cases `- [ ]` se cochent directement dans la note |
| Hauteur d'un widget | Mode Modifier : sélecteur (Auto, 150 à 800 px) ou tirer la barre en bas du widget ; valeur libre dans ⚙. Le contenu défile si la hauteur est fixée. |
| Démarrer / arrêter / redémarrer un conteneur | Widget Docker, boutons ▶ ■ ↻ (admin connecté, source « Agent Mon dashboard » avec actions autorisées) |
| Configurer un widget | ⚙ (sources, options, favoris…) |
| Connexions aux serveurs | **⚙ Paramètres → Intégrations** (avec bouton « Tester la connexion ») |
| Consultation sans connexion | ⚙ Paramètres → Général (lecture seule ; les actions restent réservées à l'admin) |

**Icônes des favoris :** indique un nom du dépôt [dashboard-icons](https://github.com/homarr-labs/dashboard-icons) (`plex`, `jellyfin`, `home-assistant`…), une URL d'image ou un emoji. Si l'icône est introuvable, l'initiale s'affiche à la place. Le bouton ● d'un lien permet de tester une autre URL que celle du lien (par exemple l'IP interne d'un service publié via NPM), ou de désactiver le test.

---

## 3. Brancher tes vraies machines : l'agent Mon dashboard

Chaque machine Linux (Debian, Unraid…) reçoit un petit conteneur **homedash-agent**, fourni avec le projet (dossier `agent/`, sans dépendance). Il remplace Glances et le socket-proxy :

- CPU, RAM, réseau, charge, températures ;
- GPU Nvidia (utilisation, VRAM, encodeur/décodeur) ;
- **SMART réel** (`smartctl` : verdict, secteurs réalloués/en attente, usure NVMe), sans réveiller les disques en veille. Un disque qui ne répond plus est signalé ;
- volumes de stockage (array Unraid, cache, disques) ;
- **mises à jour** : paquets apt (Debian, avec les correctifs de sécurité repérés), Unraid OS et plugins, **images Docker obsolètes** ;
- **démarrer / arrêter / redémarrer** les conteneurs.

### Installation (tout se fait dans l'interface)

1. ⚙ Paramètres → Intégrations → ＋ → **Agent Mon dashboard**.
2. Choisis le mode :
   - **pull** (réseau local) : Mon dashboard interroge l'agent. Indique l'URL `http://IP-de-la-machine:9123`.
   - **push** (machine distante, hors de ton réseau local) : l'agent envoie ses données à Mon dashboard toutes les 10 s. Rien à ouvrir chez la machine, mais elle doit joindre Mon dashboard (en HTTPS via NPM).
3. Enregistre : l'assistant d'installation s'ouvre. Indique l'adresse de Mon dashboard **vue depuis la machine** (jamais `localhost`) et coche « GPU Nvidia » si la machine en a une.
4. Copie la commande et lance-la en SSH sur la machine :
   ```bash
   curl -fsSL "http://IP-HOMEDASH:3080/api/agent/install/CODE" | sh        # Unraid (root)
   curl -fsSL "http://IP-HOMEDASH:3080/api/agent/install/CODE" | sudo sh   # Debian
   ```
   Le script copie l'agent dans `/mnt/user/appdata/homedash-agent` (Unraid) ou `/opt/homedash-agent` (Debian), construit l'image et démarre le conteneur. Le code expire au bout d'une heure.
5. « Tester la connexion », puis ajoute des widgets « Machine » et « Conteneurs Docker » avec cette source.

### Sécurité de l'agent

- Il tourne en `--privileged` avec la racine de l'hôte montée **en lecture seule** et le socket Docker (nécessaire pour SMART et le pilotage des conteneurs).
- Chaque requête est signée en HMAC-SHA256 avec un jeton propre à la machine et horodatée (±90 s, donc garde les horloges à l'heure). Sans le jeton, l'agent ne répond rien d'autre que `/health`.
- Pour interdire le pilotage des conteneurs sur une machine : décoche l'option dans l'intégration, ou ajoute `-e HD_ALLOW_DOCKER_ACTIONS=0` au conteneur.
- En mode pull, le port 9123 ne doit être ouvert que sur le LAN.

### Home Assistant (HAOS)

HAOS ne permet pas d'installer un conteneur libre : utilise l'intégration **Home Assistant** (jeton longue durée). Elle remonte CPU/RAM via « System Monitor » et les mises à jour `update.*`.

### Glances (optionnel)

L'intégration Glances reste disponible si tu as déjà Glances quelque part, mais elle n'est plus nécessaire.

### Services

| Service | Où trouver l'accès |
|---|---|
| **Plex** | X-Plex-Token : dans Plex Web, ⋯ → Infos → « Afficher le XML ». Le jeton est à la fin de l'URL. |
| **Jellyfin** | Tableau de bord → Clés API → ＋ |
| **qBittorrentVPN** | Identifiants de la WebUI (port 8080 par défaut chez binhex) |
| **FreshRSS** | Configuration → Authentification → autoriser l'API ; puis Profil → « Mot de passe API » |
| **Nextcloud (CalDAV)** | Adresse de ton Nextcloud (`https://cloud.exemple.fr`) et un **mot de passe d'application** (Paramètres → Sécurité). Tous tes calendriers sont trouvés automatiquement, avec leurs couleurs ; tu peux n'en garder que certains. |
| **Infomaniak (CalDAV)** | Adresse CalDAV indiquée dans les paramètres du calendrier, et ton mot de passe. Le mode « .ics » marche aussi avec un lien d'abonnement. |
| **Home Assistant** | Profil → Sécurité → Jeton d'accès longue durée ; ajoute l'intégration « System Monitor » pour CPU et RAM |
| **Météo** | Open-Meteo, sans clé. Recherche la ville dans la configuration du widget. |

Une fois les vraies intégrations en place, supprime les intégrations « Démo » dans ⚙ Paramètres → Intégrations.

---

## 4. Déploiement sur un serveur Unraid

Copie le dossier sur le serveur, puis :

```bash
docker compose -f docker-compose.unraid.yml up -d --build
```

Données dans `/mnt/user/appdata/homedash`. Expose-le via NPM en HTTPS si tu veux y accéder de l'extérieur.

### Images prêtes à l'emploi (ghcr.io)

À chaque mise à jour de la branche `main`, GitHub Actions construit et publie :

- `ghcr.io/ankister/mondashboard:latest`
- `ghcr.io/ankister/mondashboard-agent:latest`

`docker-compose.example.yml` les utilise directement : rien à construire, et les outils de mise à jour (Dockhand, Portainer, Watchtower…) détectent les nouvelles versions.

### Droits sur le dossier de données

Le conteneur démarre en root uniquement le temps d'attribuer le dossier `/data` à l'utilisateur `PUID:PGID` (1000:1000 par défaut), puis lance l'application sans privilèges. Sur Unraid, mets `PUID=99` et `PGID=100`. N'utilise pas l'option `user:` du compose, sinon cette correction automatique ne peut pas se faire.

## 5. Sécurité

- Mot de passe admin haché (scrypt), session par cookie HttpOnly / SameSite=Strict, blocage de 5 minutes après 5 échecs.
- Jetons et mots de passe des intégrations chiffrés en AES-256-GCM. La clé est dans `data/.secret_key`, ou dans la variable `SECRET_KEY`. **Sauvegarde-la avec `config.json`** : sans elle, les secrets sont illisibles.
- Le navigateur ne voit jamais les jetons : c'est le serveur Mon dashboard qui interroge les services.
- Les actions (ajout de torrent, start/stop) exigent d'être connecté en admin, même si la consultation publique est activée.

## 6. Limites connues

- **Mises à jour apt** : calculées à partir des listes que Debian rafraîchit chaque jour (`apt-daily`). Les dépôts backports sont ignorés, et les listes compressées en lz4 (Ubuntu) ne sont pas lues.
- **Mises à jour Unraid** : déduites des fichiers de vérification de plugins d'Unraid (`/tmp/plugins`), donc seulement après une vérification faite par Unraid. À considérer comme indicatif.
- **Images Docker** : comparaison du digest local et du digest du registre toutes les 6 h. Les images construites localement ne sont pas vérifiées.
- **Mode push** : une action sur un conteneur est exécutée au prochain contact de l'agent (jusqu'à 10 s).
- **Rafraîchissement** : interrogation périodique (intervalle réglable par widget), pas de WebSocket.
- **Icônes** : chargées depuis le CDN jsDelivr, donc il faut un accès Internet.

## 7. Ajouter une intégration

Crée `lib/integrations/monservice.js` avec `{ label, help, provides, fields, test(), fetch(kind, config, widgetConfig, integration), action?() }`, puis enregistre-le dans `lib/integrations/index.js`. Le formulaire d'administration est généré automatiquement à partir de `fields`.

## Crédits

- Icônes d'onglets et de barres de titre : [Lucide](https://lucide.dev) (licence ISC, voir `public/icons/lucide/LICENSE`).
- Logos des services dans les intégrations : [Simple Icons](https://simpleicons.org) (CC0 ; logo Umami sous licence MIT), voir `public/icons/brands/LICENSE`. Ce sont des marques de leurs propriétaires, utilisées seulement pour identifier le service.
- Grille des widgets : [gridstack.js](https://gridstackjs.com) (licence MIT).
