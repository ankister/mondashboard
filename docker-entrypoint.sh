#!/bin/sh
# Démarre en root uniquement le temps de donner le dossier de données au bon
# utilisateur (PUID/PGID, 1000 par défaut), puis lance l'application sans privilèges.
set -e
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  if [ "$(stat -c '%u:%g' "$DATA_DIR")" != "$PUID:$PGID" ] || [ -n "$(find "$DATA_DIR" ! -user "$PUID" -print -quit 2>/dev/null)" ]; then
    echo "Attribution de $DATA_DIR à $PUID:$PGID"
    chown -R "$PUID:$PGID" "$DATA_DIR"
  fi
  exec su-exec "$PUID:$PGID" "$@"
fi

# Lancé directement avec un utilisateur (option user: du compose)
if [ ! -w "$DATA_DIR" ]; then
  echo "ERREUR : $DATA_DIR n'est pas accessible en écriture pour l'UID $(id -u)."
  echo "Corrige avec : chown -R $(id -u):$(id -g) <dossier monté sur $DATA_DIR>, ou retire l'option user: et utilise PUID/PGID."
  exit 1
fi
exec "$@"
