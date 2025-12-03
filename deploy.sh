#!/bin/bash

# Configuration
PROJECT_ID="boreal-matrix-433916-t9"
SERVICE_NAME="tg-expense-bot"
REGION="us-central1"

echo "🚀 Deploying to Google Cloud Run..."

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "❌ Error: gcloud CLI is not installed."
    exit 1
fi

# Build and Deploy
# Note: This assumes you have already authenticated with `gcloud auth login`
# and set the project with `gcloud config set project $PROJECT_ID`

gcloud run deploy $SERVICE_NAME \
  --source . \
  --platform managed \
  --region $REGION \
  --allow-unrelated-histories \
  --set-secrets "TELEGRAM_TOKEN=telegram-token:latest,SPREADSHEET_ID=spreadsheet-id:latest,WEBHOOK_URL=webhook-url:latest,GOOGLE_CREDENTIALS_JSON=google-credentials-secret:latest"

# Note: Ensure you have created the following secrets in Secret Manager:
# - telegram-token
# - spreadsheet-id
# - webhook-url
# - google-credentials-secret

# Note: You need to create the secret 'google-credentials-secret' in Secret Manager first:
# gcloud secrets create google-credentials-secret --replication-policy="automatic"
# gcloud secrets versions add google-credentials-secret --data-file="secrets/planeta_sheets_key.json"

echo "✅ Deployment command finished (check output for status)."
