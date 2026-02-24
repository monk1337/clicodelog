// Global application state — loaded first, shared by all modules
var currentProjectId = null;
var currentSessionId = null;
var currentSource = 'claude-code';
var projects = [];
var availableSources = [];
var allThinkingExpanded = false;
var currentConversation = null;
var currentSessions = [];
var activeTagFilter = null;
var searchTimeout = null;
var conversationCache = {};
var lazyOffset = 0;
var lazyBatchSize = 50;
var activeFilters = new Set();
var lazyObserver = null;
