(function initNamespace(global){
  const RC = global.RC = global.RC || {};

  const state = RC.state = RC.state || {};
  if (typeof state.panelId === 'undefined') state.panelId = 'rc-panel';
  if (typeof state.currentPanel === 'undefined') state.currentPanel = null;
  if (typeof state.currentPanelCleanup === 'undefined') state.currentPanelCleanup = null;
  if (!state.chipRegistry) state.chipRegistry = new Map();
  if (typeof state.throttleMs === 'undefined') state.throttleMs = 400;
  if (typeof state.lastScanRun === 'undefined') state.lastScanRun = 0;
  if (typeof state.scanPending === 'undefined') state.scanPending = false;
  if (typeof state.scanTimerId === 'undefined') state.scanTimerId = 0;
  if (typeof state.scanIntervalId === 'undefined') state.scanIntervalId = 0;
  if (!state.handlers) state.handlers = {};
  if (typeof state.initialized === 'undefined') state.initialized = false;

  const config = RC.config = RC.config || {};
  if (typeof config.minReviewLength === 'undefined') config.minReviewLength = 16;
  config.storageKeys = config.storageKeys || {
    reviewText: 'rcReviewText',
    rating: 'rcRating'
  };
  config.selectors = config.selectors || {
    cards: '[role="article"], [data-review-id], div[aria-label*="review"], div.hxVHQb',
    textInputs: 'textarea, [contenteditable="true"], input[type="text"]'
  };
  config.reviewSelectors = config.reviewSelectors || [
    '[data-reviewid]',
    '[data-review-id]',
    '[data-review-text]',
    '[itemprop="reviewBody"]',
    '[jsname="fb90Dc"]',
    '[jsname="bN97Pc"]',
    '.ODSEW-ShBeI-text',
    '.ODSEW-ShBeI-fg9Q2e',
    '.ODSEW-ShBeI-jS0Naf',
    '.ODSEW-ShBeI-T3o0Zc',
    '.review-full-text',
    '.review-snippet'
  ];
  config.blockedNormalizedText = config.blockedNormalizedText || [
    'podpowiedz odpowied',
    'dodaj odpowied',
    'edytuj odpowied',
    'napisz odpowied',
    'odpowiedz opublikowana',
    'zglos recenz'
  ];
  config.ratingAriaSelectors = config.ratingAriaSelectors || [
    '[aria-label*="stars"]',
    '[aria-label*="gwiaz"]',
    '[aria-label*="ocena"]',
    '[aria-label*="Ocena"]',
    '[aria-label*="rating"]',
    '[aria-label*="Rating"]'
  ];
  config.ratingAttrNames = config.ratingAttrNames || [
    'data-rating',
    'data-star-rating',
    'data-rating-score',
    'data-initial-rating'
  ];
})(window);
