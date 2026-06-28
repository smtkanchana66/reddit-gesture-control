const videoEl = document.getElementById('video');
const overlay = document.getElementById('overlay');
const ctx = overlay.getContext('2d');
const statusEl = document.getElementById('status');
const tabStatusEl = document.getElementById('tabStatus');
const flashEl = document.getElementById('flash');
const startBtn = document.getElementById('startBtn');

let redditTabId = null;

function findRedditTab(){
  chrome.tabs.query({url: ["https://www.reddit.com/*", "https://old.reddit.com/*"]}, (tabs) => {
    if(tabs && tabs.length > 0){
      redditTabId = tabs[0].id;
      tabStatusEl.textContent = "Connected to Reddit tab: " + (tabs[0].title || tabs[0].url).slice(0, 40);
      tabStatusEl.style.color = "#46d160";
    } else {
      redditTabId = null;
      tabStatusEl.textContent = "No Reddit tab open. Open reddit.com in another tab.";
      tabStatusEl.style.color = "#ff6347";
    }
  });
}
findRedditTab();
setInterval(findRedditTab, 3000);

function sendGesture(action){
  flashEl.textContent = action;
  if(!redditTabId){
    findRedditTab();
    return;
  }
  chrome.tabs.sendMessage(redditTabId, {type: 'gesture', action}, (resp) => {
    if(chrome.runtime.lastError){
      tabStatusEl.textContent = "Lost connection to tab, retrying...";
      tabStatusEl.style.color = "#ff6347";
      redditTabId = null;
    }
  });
}

// ---------- Raw per-frame gesture classification ----------
// This part is unchanged: it just labels what the hand looks like in a
// single frame. All the "make this feel natural" logic lives in the state
// machine below, which decides what to actually DO with a stream of these
// raw labels.

function dist(a, b){
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function fingerExtended(landmarks, tipIdx, pipIdx, wristIdx = 0){
  const wrist = landmarks[wristIdx];
  return dist(landmarks[tipIdx], wrist) > dist(landmarks[pipIdx], wrist) * 1.15;
}

// Returns one of: 'fist', 'open_palm', 'thumb_up', 'thumb_down', 'none'
function classifyGesture(landmarks){
  const wrist = landmarks[0];
  const thumbTip = landmarks[4];
  const thumbMcp = landmarks[2];

  const indexExt  = fingerExtended(landmarks, 8, 6);
  const middleExt = fingerExtended(landmarks, 12, 10);
  const ringExt   = fingerExtended(landmarks, 16, 14);
  const pinkyExt  = fingerExtended(landmarks, 20, 18);

  const fourFingersFolded = !indexExt && !middleExt && !ringExt && !pinkyExt;
  const fourFingersOpen   = indexExt && middleExt && ringExt && pinkyExt;

  const thumbAboveWrist = thumbTip.y < wrist.y - 0.06;
  const thumbBelowWrist = thumbTip.y > wrist.y + 0.06;
  const thumbExtendedFromPalm = dist(thumbTip, wrist) > dist(thumbMcp, wrist) * 1.3;

  if(fourFingersFolded && thumbExtendedFromPalm && thumbAboveWrist) return 'thumb_up';
  if(fourFingersFolded && thumbExtendedFromPalm && thumbBelowWrist) return 'thumb_down';
  if(fourFingersFolded && !thumbExtendedFromPalm) return 'fist';
  if(fourFingersOpen) return 'open_palm';
  return 'none';
}

// ---------- Gesture state machine ----------
// States:
//   NEUTRAL        - nothing locked, watching for a clear gesture
//   SCROLLING      - open palm, tracking movement direction
//   VOTE_LOCKED_UP / VOTE_LOCKED_DOWN
//                  - a vote already fired for this hold; ignore repeats
//                    until the hand returns to open_palm / fist / none.
//
// Smoothing knobs (tune here if detection feels too twitchy or too slow):
const RAW_HISTORY_SIZE   = 8;   // frames kept for majority-vote smoothing
const STABLE_RATIO        = 0.7; // fraction of history that must agree
const VOTE_STABLE_FRAMES  = 6;   // consecutive stable frames before a vote fires
const VOTE_COOLDOWN_MS    = 1500; // hard floor between any two vote triggers
const POSITION_HISTORY_SIZE = 6;  // frames of wrist position kept for velocity
const SCROLL_MOVE_THRESHOLD = 0.018; // normalized-coords delta to count as real movement (ignores jitter)
const SCROLL_DIRECTION_FRAMES = 4;   // consecutive frames that must agree on direction
const SCROLL_TRIGGER_COOLDOWN_MS = 350; // min gap between repeated scroll triggers while moving

let rawHistory = [];          // recent raw per-frame gesture labels
let stableGesture = 'none';   // smoothed/debounced gesture
let state = 'NEUTRAL';

let voteStableCount = 0;      // consecutive frames the current vote gesture has held
let lastVoteTime = 0;

let wristPositionHistory = []; // [{y, t}], oldest first
let scrollDirCount = 0;        // consecutive frames agreeing on current direction
let currentScrollDir = 0;      // -1 = up, 1 = down, 0 = none
let lastScrollTriggerTime = 0;

function pushRaw(gesture){
  rawHistory.push(gesture);
  if(rawHistory.length > RAW_HISTORY_SIZE){
    rawHistory.shift();
  }
}

// Majority vote over recent frames, with hysteresis: only switch the
// "stable" gesture once a clear majority agrees, otherwise keep the
// previous stable value. This is what kills rapid flicker between
// gestures caused by single noisy frames.
function computeStableGesture(){
  if(rawHistory.length < RAW_HISTORY_SIZE) return stableGesture;
  const counts = {};
  for(const g of rawHistory){
    counts[g] = (counts[g] || 0) + 1;
  }
  let best = 'none', bestCount = 0;
  for(const g in counts){
    if(counts[g] > bestCount){
      bestCount = counts[g];
      best = g;
    }
  }
  if(bestCount / rawHistory.length >= STABLE_RATIO){
    return best;
  }
  return stableGesture; // not a clear majority yet — hold previous value
}

function resetAll(reason){
  state = 'NEUTRAL';
  voteStableCount = 0;
  wristPositionHistory = [];
  scrollDirCount = 0;
  currentScrollDir = 0;
  sendGesture('reset');
  statusEl.textContent = 'Reset (' + reason + ')';
}

// Movement-direction scrolling: we look at the wrist's y position over the
// last few frames and only act once several CONSECUTIVE frames agree on
// the same direction by more than a noise threshold. This replaces the old
// "absolute position relative to last frame" approach, which would flip
// direction near the top/bottom of the camera frame.
function updateScrollFromPalmMovement(landmarks, now){
  const wristY = landmarks[0].y;
  wristPositionHistory.push({y: wristY, t: now});
  if(wristPositionHistory.length > POSITION_HISTORY_SIZE){
    wristPositionHistory.shift();
  }
  if(wristPositionHistory.length < POSITION_HISTORY_SIZE) return;

  const oldest = wristPositionHistory[0];
  const newest = wristPositionHistory[wristPositionHistory.length - 1];
  const delta = newest.y - oldest.y; // positive = hand moved down in frame
  const dt = Math.max(newest.t - oldest.t, 1);
  const velocity = delta / dt; // px(normalized)/ms, sign = direction

  let frameDir = 0;
  if(Math.abs(delta) > SCROLL_MOVE_THRESHOLD){
    frameDir = delta < 0 ? -1 : 1; // -1 = moving up, 1 = moving down
  }

  if(frameDir !== 0 && frameDir === currentScrollDir){
    scrollDirCount++;
  } else if(frameDir !== 0){
    currentScrollDir = frameDir;
    scrollDirCount = 1;
  } else {
    // no significant movement this frame — decay rather than instantly
    // resetting, so a single still frame mid-motion doesn't cancel a swipe
    scrollDirCount = Math.max(0, scrollDirCount - 1);
    if(scrollDirCount === 0) currentScrollDir = 0;
  }

  const consistentlyMoving = scrollDirCount >= SCROLL_DIRECTION_FRAMES;
  statusEl.textContent = consistentlyMoving
    ? (currentScrollDir < 0 ? 'Scrolling: palm moving up' : 'Scrolling: palm moving down')
    : 'Open palm (move up/down to scroll)';

  if(consistentlyMoving && now - lastScrollTriggerTime > SCROLL_TRIGGER_COOLDOWN_MS){
    // Hand moving UP on screen -> advance the feed (scroll_down action).
    // Hand moving DOWN on screen -> go back (scroll_up action).
    sendGesture(currentScrollDir < 0 ? 'scroll_down' : 'scroll_up');
    lastScrollTriggerTime = now;
  }
}

function handleVoteGesture(gesture, now){
  // gesture is 'thumb_up' or 'thumb_down' here
  const lockState = gesture === 'thumb_up' ? 'VOTE_LOCKED_UP' : 'VOTE_LOCKED_DOWN';

  if(state === lockState){
    // Already fired for this hold — ignore until released.
    statusEl.textContent = (gesture === 'thumb_up' ? '👍' : '👎') + ' locked (release to vote again)';
    return;
  }

  if(state === 'VOTE_LOCKED_UP' || state === 'VOTE_LOCKED_DOWN'){
    // Switched directly from one thumb gesture to the other without
    // releasing — treat as a fresh gesture rather than silently ignoring,
    // but still require its own stability count.
    state = 'NEUTRAL';
    voteStableCount = 0;
  }

  voteStableCount++;
  statusEl.textContent = (gesture === 'thumb_up' ? '👍 thumbs up' : '👎 thumbs down') +
    ' (holding ' + voteStableCount + '/' + VOTE_STABLE_FRAMES + ')';

  const cooldownOk = now - lastVoteTime > VOTE_COOLDOWN_MS;
  if(voteStableCount >= VOTE_STABLE_FRAMES && cooldownOk){
    sendGesture(gesture === 'thumb_up' ? 'upvote' : 'downvote');
    lastVoteTime = now;
    state = lockState;
    voteStableCount = 0;
  }
}

function onResults(results){
  ctx.save();
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  const now = performance.now();

  if(results.multiHandLandmarks && results.multiHandLandmarks.length > 0){
    const landmarks = results.multiHandLandmarks[0];
    drawConnectors(ctx, landmarks, Hands.HAND_CONNECTIONS, {color: '#46d160', lineWidth: 2});
    drawLandmarks(ctx, landmarks, {color: '#ff4500', lineWidth: 1, radius: 3});

    const raw = classifyGesture(landmarks);
    pushRaw(raw);
    stableGesture = computeStableGesture();

    if(stableGesture === 'fist'){
      if(state !== 'NEUTRAL' || voteStableCount !== 0 || currentScrollDir !== 0){
        resetAll('fist');
      } else {
        statusEl.textContent = '✊ Fist (neutral)';
      }
    } else if(stableGesture === 'open_palm'){
      // Leaving a vote-lock via open palm releases it, per spec.
      if(state === 'VOTE_LOCKED_UP' || state === 'VOTE_LOCKED_DOWN'){
        state = 'NEUTRAL';
      }
      state = 'SCROLLING';
      voteStableCount = 0;
      updateScrollFromPalmMovement(landmarks, now);
    } else if(stableGesture === 'thumb_up' || stableGesture === 'thumb_down'){
      // Leaving scroll mode for a vote gesture clears scroll tracking so
      // a stray scroll doesn't fire right as the hand changes shape.
      wristPositionHistory = [];
      scrollDirCount = 0;
      currentScrollDir = 0;
      handleVoteGesture(stableGesture, now);
    } else {
      // 'none' / transitional frame — don't change lock state, just stop
      // accumulating scroll motion so noise doesn't get counted as a swipe.
      wristPositionHistory = [];
      scrollDirCount = 0;
      statusEl.textContent = 'Hand detected, no clear gesture';
    }
  } else {
    // Hand left the frame entirely — treat like a soft reset of in-flight
    // motion tracking, but keep vote locks (hand may just be repositioning).
    rawHistory = [];
    wristPositionHistory = [];
    scrollDirCount = 0;
    currentScrollDir = 0;
    statusEl.textContent = 'No hand detected';
  }
  ctx.restore();
}

const hands = new Hands({
  locateFile: (file) => chrome.runtime.getURL('lib/hands/' + file)
});
hands.setOptions({
  maxNumHands: 1,
  modelComplexity: 1,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.6
});
hands.onResults(onResults);

let camera = null;

startBtn.addEventListener('click', async () => {
  try{
    startBtn.disabled = true;
    startBtn.textContent = 'Starting...';
    camera = new Camera(videoEl, {
      onFrame: async () => { await hands.send({image: videoEl}); },
      width: 320,
      height: 240
    });
    await camera.start();
    overlay.width = 320;
    overlay.height = 240;
    startBtn.textContent = 'Running';
    statusEl.textContent = 'Camera started. Show your hand.';
  } catch(err){
    statusEl.textContent = 'Camera error: ' + err.message;
    startBtn.disabled = false;
    startBtn.textContent = 'Enable Camera & Start';
  }
});
