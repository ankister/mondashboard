// Registre des intégrations et des types de widgets.
// Pour ajouter une intégration : créer un module exportant
// { label, help, provides, fields, test(config), fetch(kind, config, widgetConfig, integration), action? }
// puis l'enregistrer ici.
import agent from './agent.js';
import glances from './glances.js';
import homeassistant from './homeassistant.js';
import docker from './docker.js';
import { plex, jellyfin } from './media.js';
import qbittorrent from './qbittorrent.js';
import { freshrss } from './feeds.js';
import calendar from './calendar.js';
import umami from './umami.js';
import demo from './demo.js';

export const INTEGRATIONS = { agent, glances, homeassistant, docker, plex, jellyfin, qbittorrent, freshrss, calendar, umami, demo };

// Types de widgets. `integrations: 'one' | 'many' | null` = combien d'intégrations le widget utilise.
// `options` décrit les réglages propres au widget (formulaire généré côté interface).
export const WIDGETS = {
  bookmarks: {
    label: 'Favoris', icon: '🔖', integrations: null, w: 12, refresh: 60,
    options: [
      { key: 'showStatus', label: 'Afficher le statut en ligne / hors ligne', type: 'checkbox', default: true },
      { key: 'style', label: 'Style', type: 'select', options: ['tuiles', 'liste'], default: 'tuiles' }
    ]
  },
  machine: {
    label: 'Machine', icon: '🖥️', integrations: 'one', kind: 'machine', w: 4, refresh: 10,
    options: [{ key: 'showDisks', label: 'Afficher les disques (SMART)', type: 'checkbox', default: true }]
  },
  docker: {
    label: 'Conteneurs Docker', icon: '🐳', integrations: 'many', kind: 'docker', w: 12, refresh: 30,
    options: [{ key: 'onlyStopped', label: 'N\'afficher que les conteneurs arrêtés', type: 'checkbox' }]
  },
  media: { label: 'Activité Plex / Jellyfin', icon: '🎬', integrations: 'many', kind: 'media', w: 6, refresh: 10, options: [] },
  torrents: {
    label: 'Torrents', icon: '🧲', integrations: 'one', kind: 'torrents', w: 6, refresh: 5,
    options: [{ key: 'limit', label: 'Nombre de torrents', type: 'number', default: 30 }]
  },
  rss: {
    label: 'Flux RSS', icon: '📰', integrations: 'optional', kind: 'rss', w: 6, refresh: 600,
    options: [
      { key: 'feeds', label: 'Flux RSS supplémentaires (une URL par ligne)', type: 'textarea' },
      { key: 'limit', label: 'Articles chargés à la fois', type: 'number', default: 40 },
      { key: 'unreadOnly', label: 'FreshRSS : non lus uniquement', type: 'checkbox' },
      { key: 'markOnScroll', label: 'FreshRSS : marquer comme lu en défilant', type: 'checkbox', default: true },
      { key: 'openInPage', label: 'Ouvrir les articles dans la page (sinon dans un nouvel onglet)', type: 'checkbox', default: true }
    ]
  },
  reader: {
    label: 'Lecteur RSS (FreshRSS)', icon: '📖', integrations: 'one', kind: 'reader', w: 12, refresh: 300,
    options: [
      { key: 'fill', label: 'Occuper toute la hauteur de la fenêtre (idéal dans un onglet dédié)', type: 'checkbox', default: true },
      { key: 'unreadOnly', label: 'Afficher les non lus par défaut', type: 'checkbox', default: true },
      { key: 'order', label: 'Ordre des articles', type: 'select', options: ['Plus récents d\'abord', 'Plus anciens d\'abord'], default: 'Plus récents d\'abord' },
      { key: 'limit', label: 'Articles chargés à la fois', type: 'number', default: 30 },
      { key: 'showImages', label: 'Afficher les vignettes dans la liste', type: 'checkbox', default: true },
      { key: 'markOnScroll', label: 'Marquer comme lu en faisant défiler la liste', type: 'checkbox', default: false },
      { key: 'shareTemplate', label: 'Partage : texte proposé ({titre}, {lien}, {source})', type: 'text', default: '{titre} - {lien}' },
      { key: 'shareX', label: 'Partage : X', type: 'checkbox', default: true },
      { key: 'shareMastodon', label: 'Partage : Mastodon', type: 'checkbox', default: true },
      { key: 'mastodonInstance', label: 'Partage : instance Mastodon (ex. mastodon.social)', type: 'text', default: '' },
      { key: 'shareThreads', label: 'Partage : Threads', type: 'checkbox', default: true },
      { key: 'shareBluesky', label: 'Partage : Bluesky', type: 'checkbox', default: true }
    ]
  },
  umami: {
    label: 'Umami (statistiques des sites)', icon: '📈', integrations: 'many', kind: 'analytics', w: 6, refresh: 300,
    options: [
      { key: 'period', label: 'Période', type: 'select', options: ["Aujourd'hui", '24 heures', '7 jours', '30 jours'], default: '24 heures' },
      { key: 'sort', label: 'Trier par', type: 'select', options: ['Visiteurs', 'Vues', 'Nom'], default: 'Visiteurs' },
      { key: 'showActive', label: 'Afficher les visiteurs en ligne', type: 'checkbox', default: true },
      { key: 'showChart', label: 'Afficher la courbe des vues', type: 'checkbox', default: true },
      { key: 'hideEmpty', label: 'Masquer les sites sans visite sur la période', type: 'checkbox', default: false }
    ]
  },
  calendar: {
    label: 'Calendrier', icon: '📅', integrations: 'many', kind: 'calendar', w: 4, refresh: 900,
    options: [
      { key: 'view', label: 'Vue par défaut', type: 'select', options: ['liste', 'mois'], default: 'liste' },
      { key: 'days', label: 'Nombre de jours affichés (vue liste)', type: 'number', default: 14 }
    ]
  },
  title: {
    label: 'Barre de titre', icon: '🔠', integrations: null, w: 12, refresh: 3600, noData: true,
    options: [
      { key: 'subtitle', label: 'Sous-titre (optionnel)', type: 'text', default: '' },
      { key: 'icon', label: 'Icône (optionnel)', type: 'icon', default: '' },
      { key: 'size', label: 'Taille', type: 'select', options: ['Petite', 'Moyenne', 'Grande'], default: 'Moyenne' },
      { key: 'align', label: 'Alignement', type: 'select', options: ['Gauche', 'Centre', 'Droite'], default: 'Gauche' },
      { key: 'line', label: 'Trait sous le titre', type: 'checkbox', default: true },
      { key: 'card', label: 'Fond de carte', type: 'checkbox', default: false }
    ]
  },
  notes: {
    label: 'Notes (Markdown)', icon: '📝', integrations: null, w: 4, refresh: 3600, noData: true,
    options: []
  },
  stock: {
    label: 'Cours (bourse, or, crypto)', icon: '💹', integrations: null, w: 4, refresh: 300,
    options: [
      { key: 'symbol', label: 'Valeur (symbole)', type: 'ticker', default: 'BTC-EUR' },
      { key: 'label', label: 'Nom affiché (vide = nom officiel)' },
      { key: 'range', label: 'Période du graphique', type: 'select', options: ['1 jour', '5 jours', '1 mois', '3 mois', '6 mois', '1 an', '5 ans', 'Max'], default: '1 mois' },
      { key: 'layout', label: 'Présentation', type: 'select', options: ['Normale', 'Compacte', 'Bandeau', 'Mini'], default: 'Normale' },
      { key: 'chartHeight', label: 'Hauteur du graphique en présentation Normale (px)', type: 'number', default: 110 }
    ]
  },
  weather: {
    label: 'Météo', icon: '⛅', integrations: null, w: 4, refresh: 900,
    options: [
      { key: 'city', label: 'Ville', type: 'city', default: 'Paris' },
      { key: 'lat', label: 'Latitude', type: 'number', default: 48.8566 },
      { key: 'lon', label: 'Longitude', type: 'number', default: 2.3522 },
      { key: 'layout', label: 'Présentation', type: 'select', options: ['Complète', 'Compacte', 'Bandeau', 'Mini'], default: 'Complète' },
      { key: 'showClock', label: 'Afficher l\'heure et la date', type: 'checkbox', default: true },
      { key: 'showHourly', label: 'Prévisions par heure', type: 'checkbox', default: true },
      { key: 'hours', label: 'Nombre d\'heures', type: 'number', default: 24 },
      { key: 'showDaily', label: 'Prévisions par jour', type: 'checkbox', default: true },
      { key: 'days', label: 'Nombre de jours', type: 'number', default: 5 }
    ]
  }
};

export function publicMeta() {
  return {
    integrations: Object.fromEntries(Object.entries(INTEGRATIONS).map(([k, v]) =>
      [k, { label: v.label, help: v.help, provides: v.provides, fields: v.fields }])),
    widgets: WIDGETS
  };
}
