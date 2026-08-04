#!/bin/bash

set -euo pipefail

OUTPUT_FILE="/private/tmp/evele-runtime-secrets.env"
umask 077

read_secret() {
  local prompt="$1"
  local variable_name="$2"
  local value=""

  while [ -z "$value" ]; do
    printf "%s" "$prompt"
    IFS= read -r -s value
    printf "\n"
    if [ -z "$value" ]; then
      printf "Значение не может быть пустым. Попробуй ещё раз.\n"
    fi
  done

  printf -v "$variable_name" "%s" "$value"
}

printf "\nAmal AI Studio — безопасное подключение сервисов\n"
printf "Вводимые значения не отображаются на экране и не попадут в чат.\n\n"

read_secret "1/7 Google Places API key: " GOOGLE_PLACES_API_KEY
read_secret "2/7 PageSpeed API key: " PAGESPEED_API_KEY
read_secret "3/7 Gmail OAuth Client ID: " GMAIL_CLIENT_ID
read_secret "4/7 Gmail OAuth Client Secret: " GMAIL_CLIENT_SECRET
read_secret "5/7 Gmail Refresh Token: " GMAIL_REFRESH_TOKEN
read_secret "6/7 Gmail sender address: " GMAIL_SENDER
printf "7/7 Почтовый адрес компании для footer исходящих писем\n"
printf "    Если пока не хочешь его указывать, просто нажми Enter.\n"
printf "    Реальная отправка писем останется выключенной: "
IFS= read -r -s OUTREACH_POSTAL_ADDRESS
printf "\n"

{
  printf 'GOOGLE_PLACES_API_KEY=%s\n' "$GOOGLE_PLACES_API_KEY"
  printf 'PAGESPEED_API_KEY=%s\n' "$PAGESPEED_API_KEY"
  printf 'GMAIL_CLIENT_ID=%s\n' "$GMAIL_CLIENT_ID"
  printf 'GMAIL_CLIENT_SECRET=%s\n' "$GMAIL_CLIENT_SECRET"
  printf 'GMAIL_REFRESH_TOKEN=%s\n' "$GMAIL_REFRESH_TOKEN"
  printf 'GMAIL_SENDER=%s\n' "$GMAIL_SENDER"
  if [ -n "$OUTREACH_POSTAL_ADDRESS" ]; then
    printf 'OUTREACH_POSTAL_ADDRESS=%s\n' "$OUTREACH_POSTAL_ADDRESS"
  fi
} > "$OUTPUT_FILE"

unset GOOGLE_PLACES_API_KEY PAGESPEED_API_KEY GMAIL_CLIENT_ID
unset GMAIL_CLIENT_SECRET GMAIL_REFRESH_TOKEN GMAIL_SENDER
unset OUTREACH_POSTAL_ADDRESS

printf "\nГотово. Секреты временно сохранены локально с закрытыми правами.\n"
printf "Вернись в Codex и напиши: готово\n\n"
