{
  const lazy = {};

  class ZenPinnedTabsObserver {
    static ALL_EVENTS = ['TabPinned', 'TabUnpinned', 'TabMove'];

    #listeners = [];

    constructor() {
      XPCOMUtils.defineLazyPreferenceGetter(
        lazy,
        'zenPinnedTabRestorePinnedTabsToPinnedUrl',
        'zen.pinned-tab-manager.restore-pinned-tabs-to-pinned-url',
        false
      );
      XPCOMUtils.defineLazyPreferenceGetter(
        lazy,
        'zenPinnedTabCloseShortcutBehavior',
        'zen.pinned-tab-manager.close-shortcut-behavior',
        'switch'
      );
      ChromeUtils.defineESModuleGetters(lazy, { E10SUtils: 'resource://gre/modules/E10SUtils.sys.mjs' });
      this.#listenPinnedTabEvents();
    }

    #listenPinnedTabEvents() {
      const eventListener = this.#eventListener.bind(this);
      for (const event of ZenPinnedTabsObserver.ALL_EVENTS) {
        window.addEventListener(event, eventListener);
      }
      window.addEventListener('unload', () => {
        for (const event of ZenPinnedTabsObserver.ALL_EVENTS) {
          window.removeEventListener(event, eventListener);
        }
      });
    }

    #eventListener(event) {
      for (const listener of this.#listeners) {
        listener(event.type, event);
      }
    }

    addPinnedTabListener(listener) {
      this.#listeners.push(listener);
    }
  }

  class ZenPinnedTabManager extends ZenDOMOperatedFeature {
    async init() {
      if (!this.enabled) {
        return;
      }
      this._canLog = Services.prefs.getBoolPref('zen.pinned-tab-manager.debug', false);
      this.observer = new ZenPinnedTabsObserver();
      this._initClosePinnedTabShortcut();
      this._insertItemsIntoTabContextMenu();
      this.observer.addPinnedTabListener(this._onPinnedTabEvent.bind(this));

      this._zenClickEventListener = this._onTabClick.bind(this);
      ZenWorkspaces.addChangeListeners(this.onWorkspaceChange.bind(this));

      await ZenPinnedTabsStorage.promiseInitialized;
      ZenWorkspaces._resolvePinnedInitialized();
    }

    async onWorkspaceChange(newWorkspace, onInit) {
      if (!this.enabled || PrivateBrowsingUtils.isWindowPrivate(window)) {
        return;
      }

      if (onInit) {
        await this._refreshPinnedTabs({ init: onInit });
        this._hasFinishedLoading = true;
      }
    }

    log(message) {
      if (this._canLog) {
        console.log(`[ZenPinnedTabManager] ${message}`);
      }
    }

    onTabIconChanged(tab, url = null) {
      if (tab.hasAttribute('zen-essential') && this._pinsCache) {
        const pin = this._pinsCache.find((pin) => pin.uuid === tab.getAttribute('zen-pin-id'));
        if (pin) {
          tab.querySelector('.tab-background').style.setProperty('--zen-tab-icon', `url(${pin.iconUrl})`);
        }
      }
      // TODO: work on this
      //if (tab.hasAttribute('zen-pinned-changed') || !this._pinsCache) {
      //  return;
      //}
      // Save if the url is the same as the pinned tab
      //const pin = this._pinsCache.find((pin) => pin.uuid === tab.getAttribute('zen-pin-id'));
      //if (pin) {
      //  pin.iconUrl = iconUrl;
      //  this.savePin(pin);
      //}
    }

    _onTabResetPinButton(event, tab) {
      event.stopPropagation();
      const pin = this._pinsCache?.find((pin) => pin.uuid === tab.getAttribute('zen-pin-id'));
      if (!pin) {
        return;
      }
      let userContextId;
      if (tab.hasAttribute('usercontextid')) {
        userContextId = tab.getAttribute('usercontextid');
      }
      const pinnedUrl = Services.io.newURI(pin.url);
      const browser = tab.linkedBrowser;
      browser.loadURI(pinnedUrl, {
        triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({
          userContextId,
        }),
      });
      this.resetPinChangedUrl(tab);
    }

    get enabled() {
      if (typeof this._enabled === 'undefined') {
        this._enabled = !(
          PrivateBrowsingUtils.isWindowPrivate(window) ||
          document.documentElement.getAttribute('chromehidden')?.includes('toolbar') ||
          document.documentElement.getAttribute('chromehidden')?.includes('menubar')
        );
      }
      return this._enabled;
    }

    async _refreshPinnedTabs({ init = false } = {}) {
      await ZenWorkspaces.promiseSectionsInitialized;
      await this._initializePinsCache();
      await this._initializePinnedTabs(init);
    }

    async _initializePinsCache() {
      try {
        // Get pin data
        const pins = await ZenPinnedTabsStorage.getPins();

        // Enhance pins with favicons
        const enhancedPins = await Promise.all(
          pins.map(async (pin) => {
            try {
              const image = await this.getFaviconAsBase64(Services.io.newURI(pin.url).spec);
              return {
                ...pin,
                iconUrl: image || null,
              };
            } catch (ex) {
              // If favicon fetch fails, continue without icon
              return {
                ...pin,
                iconUrl: null,
              };
            }
          })
        );

        this._pinsCache = enhancedPins.sort((a, b) => {
          if (!a.workspaceUuid && b.workspaceUuid) return -1;
          if (a.workspaceUuid && !b.workspaceUuid) return 1;
          return 0;
        });
      } catch (ex) {
        console.error('Failed to initialize pins cache:', ex);
        this._pinsCache = [];
      }

      this.log(`Initialized pins cache with ${this._pinsCache.length} pins`);
      return this._pinsCache;
    }

    async _initializePinnedTabs(init = false) {
      const pins = this._pinsCache;
      if (!pins?.length || !init) {
        return;
      }

      const pinnedTabsByUUID = new Map();
      const pinsToCreate = new Set(pins.map((p) => p.uuid));

      // First pass: identify existing tabs and remove those without pins
      for (let tab of ZenWorkspaces.allStoredTabs) {
        const pinId = tab.getAttribute('zen-pin-id');
        if (!pinId) {
          continue;
        }

        if (pinsToCreate.has(pinId)) {
          // This is a valid pinned tab that matches a pin
          pinnedTabsByUUID.set(pinId, tab);
          pinsToCreate.delete(pinId);

          if (lazy.zenPinnedTabRestorePinnedTabsToPinnedUrl && init) {
            this._resetTabToStoredState(tab);
          }
        } else {
          // This is a pinned tab that no longer has a corresponding pin
          gBrowser.removeTab(tab);
        }
      }

      // Second pass: For every existing tab, update its label
      // and set 'zen-has-static-label' attribute if it's been edited
      for (let pin of pins) {
        const tab = pinnedTabsByUUID.get(pin.uuid);
        if (!tab) {
          continue;
        }

        if (pin.title && pin.editedTitle) {
          gBrowser._setTabLabel(tab, pin.title);
          tab.setAttribute('zen-has-static-label', 'true');
        }
      }

      // Third pass: create new tabs for pins that don't have tabs
      for (let pin of pins) {
        try {
          if (!pinsToCreate.has(pin.uuid)) {
            continue; // Skip pins that already have tabs
          }

          let params = {
            skipAnimation: true,
            allowInheritPrincipal: false,
            skipBackgroundNotify: true,
            userContextId: pin.containerTabId || 0,
            createLazyBrowser: true,
            skipLoad: true,
            noInitialLabel: false,
          };

          // Create and initialize the tab
          let newTab = gBrowser.addTrustedTab(pin.url, params);
          newTab.setAttribute('zenDefaultUserContextId', true);

          // Set initial label/title
          if (pin.title) {
            gBrowser.setInitialTabTitle(newTab, pin.title);
          }

          // Set the icon if we have it cached
          if (pin.iconUrl) {
            gBrowser.setIcon(newTab, pin.iconUrl);
          }

          newTab.setAttribute('zen-pin-id', pin.uuid);

          if (pin.workspaceUuid) {
            newTab.setAttribute('zen-workspace-id', pin.workspaceUuid);
          }

          if (pin.isEssential) {
            newTab.setAttribute('zen-essential', 'true');
          }

          if (pin.editedTitle) {
            newTab.setAttribute('zen-has-static-label', 'true');
          }

          // Initialize browser state if needed
          if (!newTab.linkedBrowser._remoteAutoRemoved) {
            let state = {
              entries: [
                {
                  url: pin.url,
                  title: pin.title,
                  triggeringPrincipal_base64: E10SUtils.SERIALIZED_SYSTEMPRINCIPAL,
                },
              ],
              userContextId: pin.containerTabId || 0,
              image: pin.iconUrl,
            };

            SessionStore.setTabState(newTab, state);
          }

          this.log(`Created new pinned tab for pin ${pin.uuid} (isEssential: ${pin.isEssential})`);
          gBrowser.pinTab(newTab);
          if (!pin.isEssential) {
            const container = document.querySelector(
              `#vertical-pinned-tabs-container .zen-workspace-tabs-section[zen-workspace-id="${pin.workspaceUuid}"]`
            );
            if (container) {
              container.insertBefore(newTab, container.lastChild);
            }
          } else {
            document.getElementById('zen-essentials-container').appendChild(newTab);
          }
          gBrowser.tabContainer._invalidateCachedTabs();
          newTab.initialize();
          if (!ZenWorkspaces.essentialShouldShowTab(newTab)) {
            gBrowser.hideTab(newTab, undefined, true);
          }
        } catch (ex) {
          console.error('Failed to initialize pinned tabs:', ex);
        }
      }

      gBrowser._updateTabBarForPinnedTabs();
      gZenUIManager.updateTabsToolbar();
    }

    _onPinnedTabEvent(action, event) {
      if (!this.enabled) return;
      const tab = event.target;
      switch (action) {
        case 'TabPinned':
          tab._zenClickEventListener = this._zenClickEventListener;
          tab.addEventListener('click', tab._zenClickEventListener);
          this._setPinnedAttributes(tab);
          break;
        case 'TabUnpinned':
          this._removePinnedAttributes(tab);
          if (tab._zenClickEventListener) {
            tab.removeEventListener('click', tab._zenClickEventListener);
            delete tab._zenClickEventListener;
          }
          break;
        case 'TabMove':
          this._onTabMove(tab);
          break;
        default:
          console.warn('ZenPinnedTabManager: Unhandled tab event', action);
          break;
      }
    }

    async _onTabMove(tab) {
      if (!tab.pinned) {
        return;
      }

      // Recollect pinned tabs and essentials after a tab move
      tab.position = tab._tPos;

      for (let otherTab of gBrowser.tabs) {
        if (otherTab.pinned) {
          const actualPin = this._pinsCache.find((pin) => pin.uuid === otherTab.getAttribute('zen-pin-id'));
          if (!actualPin) {
            continue;
          }
          actualPin.position = otherTab._tPos;
          await this.savePin(actualPin, false);
        }
      }

      const actualPin = this._pinsCache.find((pin) => pin.uuid === tab.getAttribute('zen-pin-id'));

      if (!actualPin) {
        return;
      }
      actualPin.position = tab.position;
      actualPin.isEssential = tab.hasAttribute('zen-essential');
      await this.savePin(actualPin);
    }

    _onTabClick(e) {
      const tab = e.target?.closest('tab');
      if (e.button === 1 && tab) {
        this._onCloseTabShortcut(e, tab);
      }
    }

    async resetPinnedTab(tab) {
      if (!tab) {
        tab = TabContextMenu.contextTab;
      }

      if (!tab || !tab.pinned) {
        return;
      }

      await this._resetTabToStoredState(tab);
    }

    async replacePinnedUrlWithCurrent() {
      const tab = TabContextMenu.contextTab;
      if (!tab || !tab.pinned || !tab.getAttribute('zen-pin-id')) {
        return;
      }

      const browser = tab.linkedBrowser;

      const pin = this._pinsCache.find((pin) => pin.uuid === tab.getAttribute('zen-pin-id'));

      if (!pin) {
        return;
      }

      const userContextId = tab.getAttribute('usercontextid');

      pin.title = tab.label || browser.contentTitle;
      pin.url = browser.currentURI.spec;
      pin.workspaceUuid = tab.getAttribute('zen-workspace-id');
      pin.userContextId = userContextId ? parseInt(userContextId, 10) : 0;

      await this.savePin(pin);
      this.resetPinChangedUrl(tab);
      await this._refreshPinnedTabs();
      gZenUIManager.showToast('zen-pinned-tab-replaced');
    }

    async _setPinnedAttributes(tab) {
      if (tab.hasAttribute('zen-pin-id') || !this._hasFinishedLoading) {
        return;
      }

      this.log(`Setting pinned attributes for tab ${tab.linkedBrowser.currentURI.spec}`);
      const browser = tab.linkedBrowser;

      const uuid = gZenUIManager.generateUuidv4();
      const userContextId = tab.getAttribute('usercontextid');

      let entry = null;

      if (tab.getAttribute('zen-pinned-entry')) {
        entry = JSON.parse(tab.getAttribute('zen-pinned-entry'));
      }

      await this.savePin({
        uuid,
        title: entry?.title || tab.label || browser.contentTitle,
        url: entry?.url || browser.currentURI.spec,
        containerTabId: userContextId ? parseInt(userContextId, 10) : 0,
        workspaceUuid: tab.getAttribute('zen-workspace-id'),
        isEssential: tab.getAttribute('zen-essential') === 'true',
      });

      tab.setAttribute('zen-pin-id', uuid);

      // This is used while migrating old pins to new system - we don't want to refresh when migrating
      if (tab.getAttribute('zen-pinned-entry')) {
        tab.removeAttribute('zen-pinned-entry');
        return;
      }
      this.onLocationChange(browser);
      await this._refreshPinnedTabs();
    }

    async _removePinnedAttributes(tab, isClosing = false) {
      tab.removeAttribute('zen-has-static-label');
      if (!tab.getAttribute('zen-pin-id') || this._temporarilyUnpiningEssential) {
        return;
      }

      if (Services.startup.shuttingDown || window.skipNextCanClose) {
        return;
      }

      this.log(`Removing pinned attributes for tab ${tab.getAttribute('zen-pin-id')}`);
      await ZenPinnedTabsStorage.removePin(tab.getAttribute('zen-pin-id'));
      this.resetPinChangedUrl(tab);

      if (!isClosing) {
        tab.removeAttribute('zen-pin-id');

        if (!tab.hasAttribute('zen-workspace-id') && ZenWorkspaces.workspaceEnabled) {
          const workspace = await ZenWorkspaces.getActiveWorkspace();
          tab.setAttribute('zen-workspace-id', workspace.uuid);
        }
      }
      await this._refreshPinnedTabs();
    }

    _initClosePinnedTabShortcut() {
      let cmdClose = document.getElementById('cmd_close');

      if (cmdClose) {
        cmdClose.addEventListener('command', this._onCloseTabShortcut.bind(this));
      }
    }

    async savePin(pin, notifyObservers = true) {
      await ZenPinnedTabsStorage.savePin(pin, notifyObservers);
      // Update the cache
      const existingPin = this._pinsCache.find((p) => p.uuid === pin.uuid);
      if (existingPin) {
        Object.assign(existingPin, pin);
      }
    }

    _onCloseTabShortcut(event, selectedTab = gBrowser.selectedTab, behavior = lazy.zenPinnedTabCloseShortcutBehavior) {
      if (!selectedTab?.pinned) {
        return;
      }

      event.stopPropagation();
      event.preventDefault();

      switch (behavior) {
        case 'close':
          this._removePinnedAttributes(selectedTab, true);
          gBrowser.removeTab(selectedTab, { animate: true });
          break;
        case 'reset-unload-switch':
        case 'unload-switch':
        case 'reset-switch':
        case 'switch':
          this._handleTabSwitch(selectedTab);
          if (behavior.includes('reset')) {
            this._resetTabToStoredState(selectedTab);
          }
          if (behavior.includes('unload')) {
            if (selectedTab.hasAttribute('glance-id')) {
              break;
            }
            // Do not unload about:* pages
            if (!selectedTab.linkedBrowser?.currentURI.spec.startsWith('about:')) {
              gBrowser.explicitUnloadTabs([selectedTab]);
              selectedTab.removeAttribute('linkedpanel');
            }
          }
          break;
        case 'reset':
          this._resetTabToStoredState(selectedTab);
          break;
        default:
          return;
      }
    }

    _handleTabSwitch(selectedTab) {
      if (selectedTab !== gBrowser.selectedTab) {
        return;
      }
      const findNextTab = (direction) =>
        gBrowser.tabContainer.findNextTab(selectedTab, {
          direction,
          filter: (tab) => !tab.hidden && !tab.pinned,
        });

      let nextTab = findNextTab(1) || findNextTab(-1);

      if (!nextTab) {
        ZenWorkspaces.selectEmptyTab();
        return;
      }

      if (nextTab) {
        gBrowser.selectedTab = nextTab;
      }
    }

    async _resetTabToStoredState(tab) {
      const id = tab.getAttribute('zen-pin-id');
      if (!id) {
        return;
      }

      const pin = this._pinsCache.find((pin) => pin.uuid === id);
      if (!pin) {
        return;
      }

      const tabState = SessionStore.getTabState(tab);
      const state = JSON.parse(tabState);

      state.entries = [
        {
          url: pin.url,
          title: pin.title,
          triggeringPrincipal_base64: lazy.E10SUtils.SERIALIZED_SYSTEMPRINCIPAL,
        },
      ];

      state.image = pin.iconUrl || null;
      state.index = 0;

      SessionStore.setTabState(tab, state);
      this.resetPinChangedUrl(tab);
    }

    async getFaviconAsBase64(pageUrl) {
      try {
        // Get the favicon data
        const faviconData = await PlacesUtils.promiseFaviconData(pageUrl);

        // The data comes as an array buffer, we need to convert it to base64
        // First create a byte array from the data
        const array = new Uint8Array(faviconData.data);

        // Convert to base64
        const base64String = btoa(
          Array.from(array)
            .map((b) => String.fromCharCode(b))
            .join('')
        );

        // Return as a proper data URL
        return `data:${faviconData.mimeType};base64,${base64String}`;
      } catch (ex) {
        // console.error("Failed to get favicon:", ex);
        return `page-icon:${pageUrl}`; // Use this as a fallback
      }
    }

    addToEssentials(tab) {
      const tabs = tab
        ? // if it's already an array, dont make it [tab]
          tab?.length
          ? tab
          : [tab]
        : TabContextMenu.contextTab.multiselected
          ? gBrowser.selectedTabs
          : [TabContextMenu.contextTab];
      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        if (tab.hasAttribute('zen-essential')) {
          continue;
        }
        tab.setAttribute('zen-essential', 'true');
        if (tab.hasAttribute('zen-workspace-id')) {
          tab.removeAttribute('zen-workspace-id');
        }
        if (tab.pinned && tab.hasAttribute('zen-pin-id')) {
          const pin = this._pinsCache.find((pin) => pin.uuid === tab.getAttribute('zen-pin-id'));
          if (pin) {
            pin.isEssential = true;
            this.savePin(pin);
          }
          document.getElementById('zen-essentials-container').appendChild(tab);
          gBrowser.tabContainer._invalidateCachedTabs();
        } else {
          gBrowser.pinTab(tab);
        }
        this._onTabMove(tab);
        this.onTabIconChanged(tab);
      }
      gZenUIManager.updateTabsToolbar();
    }

    removeEssentials(tab, unpin = true) {
      const tabs = tab ? [tab] : TabContextMenu.contextTab.multiselected ? gBrowser.selectedTabs : [TabContextMenu.contextTab];
      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        tab.removeAttribute('zen-essential');
        if (ZenWorkspaces.workspaceEnabled && ZenWorkspaces.getActiveWorkspaceFromCache().uuid) {
          tab.setAttribute('zen-workspace-id', ZenWorkspaces.getActiveWorkspaceFromCache().uuid);
        }
        if (unpin) {
          gBrowser.unpinTab(tab);
        } else {
          const pinContainer = ZenWorkspaces.pinnedTabsContainer;
          pinContainer.prepend(tab);
          gBrowser.tabContainer._invalidateCachedTabs();
          this._onTabMove(tab);
        }
      }
      gZenUIManager.updateTabsToolbar();
    }

    _insertItemsIntoTabContextMenu() {
      const elements = window.MozXULElement.parseXULToFragment(`
            <menuseparator id="context_zen-pinned-tab-separator" hidden="true"/>
            <menuitem id="context_zen-replace-pinned-url-with-current"
                      data-lazy-l10n-id="tab-context-zen-replace-pinned-url-with-current"
                      hidden="true"
                      oncommand="gZenPinnedTabManager.replacePinnedUrlWithCurrent();"/>
            <menuitem id="context_zen-reset-pinned-tab"
                      data-lazy-l10n-id="tab-context-zen-reset-pinned-tab"
                      hidden="true"
                      oncommand="gZenPinnedTabManager.resetPinnedTab();"/>
        `);
      document.getElementById('tabContextMenu').appendChild(elements);

      const element = window.MozXULElement.parseXULToFragment(`
            <menuitem id="context_zen-add-essential"
                      data-lazy-l10n-id="tab-context-zen-add-essential"
                      hidden="true"
                      oncommand="gZenPinnedTabManager.addToEssentials();"/>
            <menuitem id="context_zen-remove-essential"
                      data-lazy-l10n-id="tab-context-zen-remove-essential"
                      hidden="true"
                      oncommand="gZenPinnedTabManager.removeEssentials();"/>
        `);

      document.getElementById('context_pinTab')?.before(element);
    }

    // TODO: remove this as it's not possible to know the base pinned url any more as it's now stored in tab state
    resetPinnedTabData(tabData) {
      if (lazy.zenPinnedTabRestorePinnedTabsToPinnedUrl && tabData.pinned && tabData.zenPinnedEntry) {
        tabData.entries = [JSON.parse(tabData.zenPinnedEntry)];
        tabData.image = tabData.zenPinnedIcon;
        tabData.index = 0;
      }
    }

    updatePinnedTabContextMenu(contextTab) {
      if (!this.enabled) {
        return;
      }
      const isVisible = contextTab.pinned && !contextTab.multiselected;
      document.getElementById('context_zen-reset-pinned-tab').hidden = !isVisible || !contextTab.getAttribute('zen-pin-id');
      document.getElementById('context_zen-replace-pinned-url-with-current').hidden = !isVisible;
      document.getElementById('context_zen-add-essential').hidden = contextTab.getAttribute('zen-essential');
      document.getElementById('context_zen-remove-essential').hidden = !contextTab.getAttribute('zen-essential');
      document.getElementById('context_unpinTab').hidden =
        document.getElementById('context_unpinTab').hidden || contextTab.getAttribute('zen-essential');
      document.getElementById('context_unpinSelectedTabs').hidden =
        document.getElementById('context_unpinSelectedTabs').hidden || contextTab.getAttribute('zen-essential');
      document.getElementById('context_zen-pinned-tab-separator').hidden = !isVisible;
    }

    moveToAnotherTabContainerIfNecessary(event, movingTabs) {
      const pinnedTabsTarget =
        event.target.closest('#vertical-pinned-tabs-container') || event.target.closest('.zen-current-workspace-indicator');
      const essentialTabsTarget = event.target.closest('#zen-essentials-container');
      const tabsTarget = event.target.closest('#tabbrowser-arrowscrollbox');

      let isVertical = this.expandedSidebarMode;
      let moved = false;
      for (const draggedTab of movingTabs) {
        let isRegularTabs = false;
        // Check for pinned tabs container
        if (pinnedTabsTarget) {
          if (!draggedTab.pinned) {
            gBrowser.pinTab(draggedTab);
            moved = true;
          } else if (draggedTab.hasAttribute('zen-essential')) {
            this.removeEssentials(draggedTab, false);
            moved = true;
          }
        }
        // Check for essentials container
        else if (essentialTabsTarget) {
          if (!draggedTab.hasAttribute('zen-essential')) {
            this.addToEssentials(draggedTab);
            moved = true;
            isVertical = false;
          }
        }
        // Check for normal tabs container
        else if (tabsTarget || event.target.id === 'zen-tabs-wrapper') {
          if (draggedTab.pinned && !draggedTab.hasAttribute('zen-essential')) {
            gBrowser.unpinTab(draggedTab);
            moved = true;
            isRegularTabs = true;
          } else if (draggedTab.hasAttribute('zen-essential')) {
            this.removeEssentials(draggedTab);
            moved = true;
            isRegularTabs = true;
          }
        }

        // If the tab was moved, adjust its position relative to the target tab
        if (moved) {
          const targetTab = event.target.closest('.tabbrowser-tab');
          if (targetTab) {
            const rect = targetTab.getBoundingClientRect();
            let newIndex = targetTab._tPos;

            if (isVertical) {
              const middleY = targetTab.screenY + rect.height / 2;
              if (!isRegularTabs && event.screenY > middleY) {
                newIndex++;
              } else if (isRegularTabs && event.screenY < middleY) {
                newIndex--;
              }
            } else {
              const middleX = targetTab.screenX + rect.width / 2;
              if (event.screenX > middleX) {
                newIndex++;
              }
            }
            gBrowser.moveTabTo(draggedTab, newIndex);
          }
        }
      }

      return moved;
    }

    async onLocationChange(browser) {
      const tab = gBrowser.getTabForBrowser(browser);
      if (!tab || !tab.pinned || tab.hasAttribute('zen-essential') || !this._pinsCache) {
        return;
      }
      const pin = this._pinsCache.find((pin) => pin.uuid === tab.getAttribute('zen-pin-id'));
      if (!pin) {
        return;
      }
      // Add an indicator that the pin has been changed
      if (pin.url === browser.currentURI.spec) {
        this.resetPinChangedUrl(tab);
        return;
      }
      this.pinHasChangedUrl(tab, pin);
    }

    resetPinChangedUrl(tab) {
      if (!tab.hasAttribute('zen-pinned-changed')) {
        return;
      }
      tab.removeAttribute('zen-pinned-changed');
      tab.removeAttribute('had-zen-pinned-changed');
      tab.style.removeProperty('--zen-original-tab-icon');
    }

    pinHasChangedUrl(tab, pin) {
      if (tab.hasAttribute('zen-pinned-changed')) {
        return;
      }
      if (tab.group?.hasAttribute('split-view-group')) {
        tab.setAttribute('had-zen-pinned-changed', 'true');
      } else {
        tab.setAttribute('zen-pinned-changed', 'true');
      }
      tab.style.setProperty('--zen-original-tab-icon', `url(${pin.iconUrl})`);
    }

    removeTabContainersDragoverClass() {
      this.dragIndicator.remove();
      this._dragIndicator = null;
      ZenWorkspaces.activeWorkspaceIndicator.removeAttribute('open');
    }

    get dragIndicator() {
      if (!this._dragIndicator) {
        this._dragIndicator = document.createElement('div');
        this._dragIndicator.id = 'zen-drag-indicator';
        document.body.appendChild(this._dragIndicator);
      }
      return this._dragIndicator;
    }

    get expandedSidebarMode() {
      return document.documentElement.getAttribute('zen-sidebar-expanded') === 'true';
    }

    async updatePinTitle(tab, newTitle, isEdited = true, notifyObservers = true) {
      const uuid = tab.getAttribute('zen-pin-id');
      await ZenPinnedTabsStorage.updatePinTitle(uuid, newTitle, isEdited, notifyObservers);

      await this._refreshPinnedTabs();

      const browsers = Services.wm.getEnumerator('navigator:browser');

      // update the label for the same pin across all windows
      for (const browser of browsers) {
        const tabs = browser.gBrowser.tabs;
        for (let i = 0; i < tabs.length; i++) {
          const tabToEdit = tabs[i];
          if (tabToEdit.getAttribute('zen-pin-id') === uuid && tabToEdit !== tab) {
            tabToEdit.removeAttribute('zen-has-static-label');
            if (isEdited) {
              gBrowser._setTabLabel(tabToEdit, newTitle);
              tabToEdit.setAttribute('zen-has-static-label', 'true');
            } else {
              gBrowser.setTabTitle(tabToEdit);
            }
            break;
          }
        }
      }
    }

    applyDragoverClass(event, draggedTab) {
      const pinnedTabsTarget = event.target.closest('#vertical-pinned-tabs-container');
      const essentialTabsTarget = event.target.closest('#zen-essentials-container');
      const tabsTarget = event.target.closest('#tabbrowser-arrowscrollbox');
      let targetTab = event.target.closest('.tabbrowser-tab');
      targetTab = targetTab?.group || targetTab;
      if (event.target.closest('.zen-current-workspace-indicator')) {
        this.removeTabContainersDragoverClass();
        ZenWorkspaces.activeWorkspaceIndicator.setAttribute('open', true);
      } else {
        ZenWorkspaces.activeWorkspaceIndicator.removeAttribute('open');
      }

      // If there's no valid target tab, nothing to do
      if (!targetTab) {
        return;
      }

      let shouldAddDragOverElement = false;
      let isVertical = this.expandedSidebarMode;

      // Decide whether we should show a dragover class for the given target
      if (pinnedTabsTarget) {
        if (!draggedTab.pinned || draggedTab.hasAttribute('zen-essential')) {
          shouldAddDragOverElement = true;
        }
      } else if (essentialTabsTarget) {
        if (!draggedTab.hasAttribute('zen-essential')) {
          shouldAddDragOverElement = true;
          isVertical = false;
        }
      } else if (tabsTarget) {
        if (draggedTab.pinned || draggedTab.hasAttribute('zen-essential')) {
          shouldAddDragOverElement = true;
        }
      }

      if (!shouldAddDragOverElement) {
        this.removeTabContainersDragoverClass();
        return;
      }

      // Calculate middle to decide 'before' or 'after'
      const rect = targetTab.getBoundingClientRect();

      if (isVertical) {
        const separation = 8;
        const middleY = targetTab.screenY + rect.height / 2;
        const indicator = this.dragIndicator;
        let top = 0;
        if (event.screenY > middleY) {
          top = rect.top + rect.height + 'px';
        } else {
          top = rect.top + 'px';
        }
        indicator.setAttribute('orientation', 'horizontal');
        indicator.style.setProperty('--indicator-left', rect.left + separation / 2 + 'px');
        indicator.style.setProperty('--indicator-width', rect.width - separation + 'px');
        indicator.style.top = top;
        indicator.style.removeProperty('left');
      } else {
        const separation = 8;
        const middleX = targetTab.screenX + rect.width / 2;
        const indicator = this.dragIndicator;
        let left = 0;
        if (event.screenX > middleX) {
          left = rect.left + rect.width + 1 + 'px';
        } else {
          left = rect.left - 2 + 'px';
        }
        indicator.setAttribute('orientation', 'vertical');
        indicator.style.setProperty('--indicator-top', rect.top + separation / 2 + 'px');
        indicator.style.setProperty('--indicator-height', rect.height - separation + 'px');
        indicator.style.left = left;
        indicator.style.removeProperty('top');
      }
    }
  }

  window.gZenPinnedTabManager = new ZenPinnedTabManager();
}
