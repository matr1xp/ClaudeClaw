#!/bin/bash
# Send a Telegram message from the command line.
# Usage: ./scripts/notify.sh "Your message here"
#
# Reads TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_IDS from .env

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env file not found at $ENV_FILE"
  exit 1
fi

# Parse .env
TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
CHAT_IDS=$(grep -E '^ALLOWED_CHAT_IDS=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"' | tr -d "'")

if [ -z "$TOKEN" ]; then
  echo "Error: TELEGRAM_BOT_TOKEN not set in .env"
  exit 1
fi

if [ -z "$CHAT_IDS" ]; then
  echo "Error: ALLOWED_CHAT_IDS not set in .env"
  exit 1
fi

MESSAGE="$1"
if [ -z "$MESSAGE" ]; then
  echo "Usage: $0 \"message\""
  exit 1
fi

# Send to each chat ID
IFS=',' read -ra IDS <<< "$CHAT_IDS"
for CHAT_ID in "${IDS[@]}"; do
  CHAT_ID=$(echo "$CHAT_ID" | xargs) # trim whitespace
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    -d "text=${MESSAGE}" \
    -d "parse_mode=HTML" > /dev/null
  echo "✓ Sent to ${CHAT_ID}"
done
