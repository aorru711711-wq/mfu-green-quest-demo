# MFU Green Quest (demo)

A student prototype for the MFU course "AI Essentials for Work and Everyday Learning".
Take a photo of a piece of waste and Google Gemini says which Thai bin it goes in, with a short prep tip. You earn Eco-XP for your dorm through quests and a leaderboard (other dorms' numbers are example data).

**Try it:** open the GitHub Pages site for this repo.

- **Demo mode needs no key.** Go to Me (⚙️), tick *Demo mode* and pick a sample answer. Every demo result has a yellow DEMO label and is canned, not a real AI answer.
- **Real mode uses your own Gemini API key** (free at https://aistudio.google.com). You paste it in Settings. It is stored **only in your browser** (localStorage) and is sent only to `generativelanguage.googleapis.com`. No key is included in this repo. Use *Delete all my data* in Settings to remove it.
- Photos are resized in the browser and never saved. Points and progress stay on your device.

Plain HTML/CSS/JavaScript: `index.html`, `style.css`, `app.js`. No build step.
This is a class prototype, not a finished product.
