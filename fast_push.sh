#!/bin/bash

# ./fast_push.sh "Ваш комментарий" - чтобы запустить

# Check if a commit message was provided
if [ -z "$1" ]; then
  echo "❌ Error: Please provide a commit message."
  echo "Usage: ./fast_push.sh \"Your commit message\""
  exit 1
fi

echo "🚀 Starting fast push..."

# Add all changes
git add .

# Commit
git commit -m "$1"

# Push
git push origin main

echo "✅ Done! Changes pushed to GitHub."
