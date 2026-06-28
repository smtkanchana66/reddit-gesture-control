// Reddit Gesture Control - content script
// Runs on www.reddit.com and old.reddit.com
// Listens for gesture commands from the panel and translates them into
// real page actions: scrolling, and clicking the actual upvote/downvote buttons.

(function(){

  function showToast(text){
    let toast = document.getElementById('__gesture_toast__');
    if(!toast){
      toast = document.createElement('div');
      toast.id = '__gesture_toast__';
      toast.style.position = 'fixed';
      toast.style.top = '16px';
      toast.style.right = '16px';
      toast.style.zIndex = 999999;
      toast.style.background = '#1a1d21';
      toast.style.color = '#d7dadc';
      toast.style.border = '1px solid #ff4500';
      toast.style.borderRadius = '8px';
      toast.style.padding = '8px 14px';
      toast.style.fontFamily = 'Arial, sans-serif';
      toast.style.fontSize = '13px';
      toast.style.opacity = '0';
      toast.style.transition = 'opacity .15s';
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.opacity = '1';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toast.style.opacity = '0'; }, 700);
  }

  function isOldReddit(){
    return location.hostname === 'old.reddit.com';
  }

  // Find the post element closest to the vertical center of the viewport.
  function getCenteredPost(){
    const center = window.innerHeight / 2;
    let candidates = [];

    if(isOldReddit()){
      candidates = Array.from(document.querySelectorAll('div.thing'));
    } else {
      candidates = Array.from(document.querySelectorAll('shreddit-post, article'));
    }

    let best = null, bestDist = Infinity;
    for(const el of candidates){
      const rect = el.getBoundingClientRect();
      if(rect.height === 0) continue;
      const elCenter = rect.top + rect.height / 2;
      const d = Math.abs(elCenter - center);
      if(d < bestDist){
        bestDist = d;
        best = el;
      }
    }
    return best;
  }

  function isVisible(el){
    if(!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && el.offsetParent !== null;
  }

  // Plain .click() doesn't always trigger React/web-component handlers that
  // listen for pointer events specifically. Fire a fuller sequence.
  function realClick(el){
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = {bubbles: true, cancelable: true, view: window, clientX: x, clientY: y};
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function clickWithin(root, selectors){
    if(!root) return false;
    for(const sel of selectors){
      const btn = root.querySelector(sel);
      if(btn && isVisible(btn)){
        realClick(btn);
        return true;
      }
    }
    return false;
  }

  // Try shadow DOM too, since modern Reddit (shreddit-post) renders vote
  // controls inside a shadow root.
  function clickWithinShadow(root, selectors){
    if(!root) return false;
    if(clickWithin(root, selectors)) return true;
    if(root.shadowRoot && clickWithin(root.shadowRoot, selectors)) return true;
    // search nested custom elements with shadow roots
    const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for(const node of all){
      if(node.shadowRoot && clickWithin(node.shadowRoot, selectors)) return true;
    }
    return false;
  }

  // --- Target post locking -------------------------------------------
  // We lock the post that is centered in the viewport at the moment a vote
  // gesture fires, then re-verify it's still the right element and still
  // visible right before clicking. This avoids voting on the wrong post if
  // the feed scrolled or re-rendered between detection and the click.
  let lockedPost = null;

  function lockTargetPost(){
    const post = getCenteredPost();
    lockedPost = post;
    return post;
  }

  function verifyLockedPostStillValid(){
    if(!lockedPost) return null;
    if(!document.contains(lockedPost)) return null;
    if(!isVisible(lockedPost)) return null;
    return lockedPost;
  }

  function voteOn(direction){
    // direction: 'up' | 'down'
    lockTargetPost();
    const post = verifyLockedPostStillValid();
    if(!post){
      showToast(`No visible post to ${direction}vote`);
      lockedPost = null;
      return;
    }

    let ok;
    if(isOldReddit()){
      ok = direction === 'up'
        ? clickWithin(post, ['.arrow.up:not(.upmod)', '.arrow.up'])
        : clickWithin(post, ['.arrow.down:not(.downmod)', '.arrow.down']);
    } else {
      ok = direction === 'up'
        ? clickWithinShadow(post, [
            'button[upvote]',
            'button[aria-pressed][aria-label*="upvote" i]',
            'button[aria-label*="upvote" i]',
            '[data-testid="upvote-button"]'
          ])
        : clickWithinShadow(post, [
            'button[downvote]',
            'button[aria-pressed][aria-label*="downvote" i]',
            'button[aria-label*="downvote" i]',
            '[data-testid="downvote-button"]'
          ]);
    }

    showToast(ok
      ? (direction === 'up' ? '👍 Upvoted' : '👎 Downvoted')
      : `Could not find ${direction}vote button (Reddit DOM may have changed)`);

    // Release the lock once the action is done — the next gesture will
    // re-lock whatever post is centered at that time.
    lockedPost = null;
  }

  function upvote(){ voteOn('up'); }
  function downvote(){ voteOn('down'); }

  function isScrollableY(el){
    if(!el || el === document.documentElement || el === document.body) return false;
    const style = getComputedStyle(el);
    const overflowY = style.overflowY;
    return (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 10;
  }

  // Reddit's redesign often scrolls an inner container, not the window, but
  // there are *multiple* scrollable containers on the page (sidebar widgets
  // like "recent posts", "popular communities", etc). We want the one that
  // actually contains the main feed / centered post — not just the first
  // scrollable element we happen to find.
  function findScrollContainer(){
    // 0) If the window/page itself scrolls (the normal case on old.reddit
    // and many pages), just use that — it's the most reliable option.
    const docEl = document.scrollingElement || document.documentElement;
    if(docEl && docEl.scrollHeight > docEl.clientHeight + 10){
      return docEl;
    }

    const post = getCenteredPost();

    // 1) Prefer a scrollable ancestor of the centered post itself.
    let node = post;
    while(node && node !== document.body){
      if(isScrollableY(node)) return node;
      node = node.parentElement;
    }

    // 2) Otherwise, scan the whole page and pick the LARGEST scrollable
    // container (sidebar widgets are small; the main feed is tall).
    const candidates = document.querySelectorAll('div, main');
    let best = null, bestArea = 0;
    for(const el of candidates){
      if(isScrollableY(el)){
        const area = el.clientWidth * el.clientHeight;
        if(area > bestArea){
          bestArea = area;
          best = el;
        }
      }
    }
    if(best) return best;

    return document.scrollingElement || document.documentElement;
  }

  function scrollFeed(direction){
    // direction: 1 = scroll down (next posts), -1 = scroll up (previous posts)
    const container = findScrollContainer();
    const amount = direction * 450;
    if(container === document.scrollingElement || container === document.documentElement){
      window.scrollBy({top: amount, behavior: 'smooth'});
    } else {
      container.scrollBy({top: amount, behavior: 'smooth'});
    }
    showToast(direction === 1 ? '⬇️ Scrolled down' : '⬆️ Scrolled up');
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if(msg && msg.type === 'gesture'){
      switch(msg.action){
        case 'scroll_down': scrollFeed(1); break;
        case 'scroll_up': scrollFeed(-1); break;
        case 'upvote': upvote(); break;
        case 'downvote': downvote(); break;
        case 'reset': lockedPost = null; break;
      }
      sendResponse({ok: true});
    }
  });

  showToast('Reddit Gesture Control active');
})();
