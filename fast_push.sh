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
# Capture output to hide warnings (like identity configuration) if successful
if commit_output=$(git commit -m "$1" 2>&1); then
    # Extract short stats if available (e.g., "1 file changed...")
    stats=$(echo "$commit_output" | grep "changed" | tail -n 1)
    echo "📸 Changes committed. $stats"
else
    # Check if it failed because there was nothing to commit
    if echo "$commit_output" | grep -q "nothing to commit"; then
        echo "⚠️ Nothing to commit."
    else
        echo "❌ Commit failed:"
        echo "$commit_output"
        exit 1
    fi
fi

# Push
echo "📤 Pushing to GitHub..."
if push_output=$(git push origin main 2>&1); then
    echo "✅ Done! Changes pushed to GitHub."
else
    echo "❌ Push failed:"
    echo "$push_output"
    exit 1
fi
