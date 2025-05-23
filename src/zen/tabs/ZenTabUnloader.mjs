{
  const lazy = {};

  XPCOMUtils.defineLazyPreferenceGetter(
    lazy,
    'zenTabUnloaderEnabled',
    'zen.tab-unloader.enabled',
    false
  );

  XPCOMUtils.defineLazyPreferenceGetter(
    lazy,
    'zenTabUnloaderTimeout',
    'zen.tab-unloader.timeout-minutes',
    20
  );

  XPCOMUtils.defineLazyPreferenceGetter(
    lazy,
    'zenTabUnloaderExcludedUrls',
    'zen.tab-unloader.excluded-urls',
    ''
  );

  const ZEN_TAB_UNLOADER_DEFAULT_EXCLUDED_URLS = [
    '^about:',
    '^chrome:',
    '^devtools:',
    '^file:',
    '^resource:',
    '^view-source:',
    '^view-image:',
  ];

  class ZenTabsObserver {
    static ALL_EVENTS = [
      'TabAttrModified',
      'TabPinned',
      'TabUnpinned',
      'TabShow',
      'TabHide',
      'TabOpen',
      'TabClose',
      'TabSelect',
      'TabMultiSelect',
    ];

    #listeners = [];

    constructor() {
      this.#listenAllEvents();
    }

    #listenAllEvents() {
      const eventListener = this.#eventListener.bind(this);
      for (const event of ZenTabsObserver.ALL_EVENTS) {
        window.addEventListener(event, eventListener);
      }
      window.addEventListener('unload', () => {
        for (const event of ZenTabsObserver.ALL_EVENTS) {
          window.removeEventListener(event, eventListener);
        }
      });
    }

    #eventListener(event) {
      for (const listener of this.#listeners) {
        listener(event.type, event);
      }
    }

    addTabsListener(listener) {
      this.#listeners.push(listener);
    }
  }

  class ZenTabsIntervalUnloader {
    static INTERVAL = 1000 * 60; // 1 minute

    interval = null;
    /** @type {ZenTabUnloader} */
    unloader = null;

    constructor(unloader) {
      this.unloader = unloader;
      this.interval = setInterval(
        this.intervalListener.bind(this),
        ZenTabsIntervalUnloader.INTERVAL
      );
    }

    intervalListener() {
      if (!lazy.zenTabUnloaderEnabled) {
        return;
      }
      const currentTimestamp = Date.now();
      const tabs = gZenWorkspaces.allStoredTabs;
      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        if (this.unloader.canUnloadTab(tab, currentTimestamp)) {
          this.unloader.unload(tab);
        }
      }
    }
  }

  class ZenTabUnloader extends ZenDOMOperatedFeature {
    static ACTIVITY_MODIFIERS = ['muted', 'soundplaying', 'label', 'attention'];

    #excludedUrls = [];
    #compiledExcludedUrls = [];
    #lastCheckedUrlTimestamp = 0;

    constructor() {
      super();

      this.#excludedUrls = this.lazyExcludeUrls;
      if (!lazy.zenTabUnloaderEnabled) {
        return;
      }
      this.intervalUnloader = new ZenTabsIntervalUnloader(this);
    }

    init() {
      if (!lazy.zenTabUnloaderEnabled) {
        return;
      }
      this.insertIntoContextMenu();
      this.observer = new ZenTabsObserver();
      this.observer.addTabsListener(this.onTabEvent.bind(this));
    }

    onTabEvent(action, event) {
      const tab = event.target;
      switch (action) {
        case 'TabPinned':
        case 'TabUnpinned':
        case 'TabShow':
        case 'TabHide':
          break;
        case 'TabAttrModified':
          this.handleTabAttrModified(tab, event);
          break;
        case 'TabOpen':
          this.handleTabOpen(tab);
          break;
        case 'TabClose':
          this.handleTabClose(tab);
          break;
        case 'TabSelect':
        case 'TabMultiSelect':
          this.updateTabActivity(tab);
          break;
        default:
          console.warn('ZenTabUnloader: Unhandled tab event', action);
          break;
      }
    }

    onLocationChange(browser) {
      const tab = browser.ownerGlobal.gBrowser.getTabForBrowser(browser);
      this.updateTabActivity(tab);
    }

    handleTabClose(tab) {
      tab.lastActivity = null;
    }

    handleTabOpen(tab) {
      this.updateTabActivity(tab);
    }

    handleTabAttrModified(tab, event) {
      for (const modifier of ZenTabUnloader.ACTIVITY_MODIFIERS) {
        if (event.detail.changed.includes(modifier)) {
          this.updateTabActivity(tab);
          break;
        }
      }
    }

    updateTabActivity(tab) {
      const currentTimestamp = Date.now();
      tab.lastActivity = currentTimestamp;
    }

    insertIntoContextMenu() {
      const element = window.MozXULElement.parseXULToFragment(`
        <menuseparator/>
        <menuitem id="context_zenUnloadTab"
                  data-lazy-l10n-id="tab-zen-unload"
                  command="cmd_zenUnloadTab"/>
        <menu data-lazy-l10n-id="zen-tabs-unloader-tab-actions" id="context_zenTabActions">
          <menupopup>
            <menuitem id="context_zenPreventUnloadTab"
                      data-lazy-l10n-id="tab-zen-prevent-unload"
                      command="cmd_zenPreventUnloadTab"/>
            <menuitem id="context_zenIgnoreUnloadTab"
                      data-lazy-l10n-id="tab-zen-ignore-unload"
                      command="cmd_zenIgnoreUnloadTab"/>
          </menupopup>
        </menu>
      `);
      document.getElementById('context_closeDuplicateTabs').parentNode.appendChild(element);
    }

    get lazyExcludeUrls() {
      return [
        ...ZEN_TAB_UNLOADER_DEFAULT_EXCLUDED_URLS,
        ...lazy.zenTabUnloaderExcludedUrls.split(',').map((url) => url.trim()),
      ];
    }

    arraysEqual(a, b) {
      if (a === b) return true;
      if (a == null || b == null) return false;
      if (a.length !== b.length) return false;

      const currentTimestamp = Date.now();
      if (currentTimestamp - this.#lastCheckedUrlTimestamp < 5 * 1000) {
        return true;
      }

      this.#lastCheckedUrlTimestamp = currentTimestamp;
      // If you don't care about the order of the elements inside
      // the array, you should sort both arrays here.
      // Please note that calling sort on an array will modify that array.
      // you might want to clone your array first.

      for (let i = 0; i < a.length; ++i) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    }

    get excludedUrls() {
      // Check if excludedrls is the same as the pref value
      const excludedUrls = this.lazyExcludeUrls;
      if (
        !this.arraysEqual(this.#excludedUrls, excludedUrls) ||
        !this.#compiledExcludedUrls.length
      ) {
        this.#excludedUrls = excludedUrls;
        this.#compiledExcludedUrls = excludedUrls.map((url) => new RegExp(url));
      }
      return this.#compiledExcludedUrls;
    }

    unload(tab, skipPermitUnload = false) {
      gBrowser.explicitUnloadTabs([tab], skipPermitUnload);
      tab.removeAttribute('linkedpanel');
    }

    unloadTab() {
      const tabs = TabContextMenu.contextTab.multiselected
        ? gBrowser.selectedTabs
        : [TabContextMenu.contextTab];
      this.explicitUnloadTabs(tabs);
    }

    explicitUnloadTabs(tabs, extraArgs = {}) {
      for (let i = 0; i < tabs.length; i++) {
        if (this.canUnloadTab(tabs[i], Date.now(), true, extraArgs)) {
          this.unload(tabs[i], true);
        }
      }
    }

    preventUnloadTab() {
      const tabs = TabContextMenu.contextTab.multiselected
        ? gBrowser.selectedTabs
        : [TabContextMenu.contextTab];
      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        tab.zenIgnoreUnload = true;
      }
    }

    ignoreUnloadTab() {
      const tabs = TabContextMenu.contextTab.multiselected
        ? gBrowser.selectedTabs
        : [TabContextMenu.contextTab];
      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        tab.zenIgnoreUnload = false;
      }
    }

    canUnloadTab(tab, currentTimestamp, ignoreTimestamp = false, extraArgs = {}) {
      if (
        (tab.pinned && !ignoreTimestamp) ||
        tab.selected ||
        (tab.multiselected && !ignoreTimestamp) ||
        (tab.hasAttribute('busy') && !ignoreTimestamp) ||
        !tab.linkedPanel ||
        tab.splitView ||
        tab.group?.hasAttribute('split-view-group') ||
        tab.attention ||
        tab.hasAttribute('glance-id') ||
        tab.linkedBrowser?.zenModeActive ||
        (tab.pictureinpicture && !ignoreTimestamp) ||
        (tab.soundPlaying && !ignoreTimestamp) ||
        (tab.zenIgnoreUnload && !ignoreTimestamp) ||
        (this.excludedUrls.some((url) => url.test(tab.linkedBrowser?.currentURI.spec)) &&
          tab.linkedBrowser?.currentURI.spec !== 'about:blank')
      ) {
        return false;
      }
      if (ignoreTimestamp) {
        return this._tabPermitsUnload(tab, extraArgs);
      }
      const lastActivity = tab.lastActivity;
      if (!lastActivity) {
        return false;
      }
      const diff = currentTimestamp - lastActivity;
      // Check if the tab has been inactive for more than the timeout
      return (
        diff > lazy.zenTabUnloaderTimeout * 60 * 1000 && this._tabPermitsUnload(tab, extraArgs)
      );
    }

    _tabPermitsUnload(tab, extraArgs) {
      return typeof extraArgs.permitUnload === 'undefined'
        ? tab.linkedBrowser?.permitUnload()?.permitUnload
        : extraArgs.permitUnload;
    }
  }

  window.gZenTabUnloader = new ZenTabUnloader();
}
