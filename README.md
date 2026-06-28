# Reddit Gesture Control (Chrome Extension)
<img src="https://github.com/smtkanchana66/reddit-gesture-control/blob/d6bed20ef7d2c69cfda80fbc788c755feed61da5/Reddit%20Gesture%20Control.png" alt="LOGO" width="200" height="200">
Control real Reddit (reddit.com / old.reddit.com) with hand gestures from your webcam:

- ✋ Open hand, move **up** → scroll feed down (next posts)
- ✋ Open hand, move **down** → scroll feed up (previous posts)
- 👍 Thumbs up → upvote the post currently centered in your viewport
- 👎 Thumbs down → downvote the post currently centered in your viewport

All hand-tracking runs locally in the panel window using a bundled copy of
Google's MediaPipe Hands model — no video leaves your machine, and no
internet calls are made to any third party at runtime (the model files are
shipped inside the extension folder).

## Install (unpacked / developer mode)

1. Unzip this folder somewhere permanent (don't delete it after installing —
   Chrome loads the extension directly from these files).
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the unzipped folder.
5. Open `reddit.com` or `old.reddit.com` in a tab.
6. Click the extension's icon in the toolbar → it opens a small **Gesture
   Control Panel** window.
7. In that panel, click **Enable Camera & Start** and allow camera access.
8. Show your hand to the camera and try the gestures above.

The panel shows "Connected to Reddit tab: ..." once it finds an open Reddit
tab. Keep that Reddit tab open (it doesn't need to be the focused/active
tab — gestures will still apply to it).

## Tips for reliable detection

- Use decent lighting and keep your hand ~30–60cm from the camera.
- For thumbs up/down, curl your other four fingers into a clear fist.
- For scrolling, keep your hand fully open (all fingers spread) and make
  one clear, deliberate vertical motion rather than drifting slowly.
- There's a ~0.9s cooldown after each triggered gesture so a single motion
  doesn't fire repeatedly.

## Important limitation: Reddit's DOM changes

Reddit frequently changes the structure of its website (especially the
new www.reddit.com, which renders posts using a `<shreddit-post>` web
component with content inside Shadow DOM). The extension tries several
fallback selectors to find upvote/downvote buttons, but if Reddit ships a
redesign, those selectors can stop matching.

- **old.reddit.com is the most reliable target** — its HTML structure is
  simple and has been stable for years (`.arrow.up` / `.arrow.down` inside
  `div.thing`).
- If voting stops working on www.reddit.com, open DevTools on a post,
  inspect the vote button, and update the selector list in `content.js`
  (function `upvote()` / `downvote()`) to match the current attribute or
  `data-testid`.

## Files

- `manifest.json` — extension config (Manifest V3)
- `background.js` — opens the gesture panel window when you click the icon
- `panel.html` / `panel.js` — camera UI + MediaPipe hand tracking + gesture
  classification, sends gesture events to the Reddit tab
- `content.js` — runs on the actual Reddit page, performs the real
  scroll/upvote/downvote actions
- `lib/` — bundled MediaPipe Hands/Camera/Drawing utility files (~24MB,
  mostly the hand-landmark model weights)
