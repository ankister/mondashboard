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
import demo from './demo.js';

export const INTEGRATIONS = { agent, glances, homeassistant, docker, plex, jellyfin, qbittorrent, freshrss, calendar, demo };

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
  calendar: {
    label: 'Calendrier', icon: '📅', integrations: 'many', kind: 'calendar', w: 4, refresh: 900,
    options: [
      { key: 'view', label: 'Vue par défaut', type: 'select', options: ['liste', 'mois'], default: 'liste' },
      { key: 'days', label: 'Nombre de jours affichés (vue liste)', type: 'number', default: 14 }
    ]
  },
  notes: {
    label: 'Notes (Markdown)', icon: '📝', integrations: null, w: 4, refresh: 3600, noData: true,
    options: []
  },
  weather: {
    label: 'Météo', icon: '⛅', integrations: null, w: 4, refresh: 900,
    options: [
      { key: 'city', label: 'Ville', type: 'city', default: 'Paris' },
      { key: 'lat', label: 'Latitude', type: 'number', default: 48.8566 },
      { key: 'lon', label: 'Longitude', type: 'number', default: 2.3522 },
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
