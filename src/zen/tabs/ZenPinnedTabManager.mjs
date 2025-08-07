// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
{
  const lazy = {};

  class ZenPinnedTabsObserver {
    static ALL_EVENTS = [
      'TabPinned',
      'TabUnpinned',
      'TabMove',
      'TabGroupCreate',
      'TabGroupRemoved',
      'TabGroupMoved',
      'ZenFolderRenamed',
      'ZenFolderIconChanged',
      'TabGroupCollapse',
      'TabGroupExpand',
      'TabGrouped',
      'TabUngrouped',
      'ZenFolderChangedWorkspace',
    ];

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
      ChromeUtils.defineESModuleGetters(lazy, {
        E10SUtils: 'resource://gre/modules/E10SUtils.sys.mjs',
      });
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

  class nsZenPinnedTabManager extends nsZenDOMOperatedFeature {
    MAX_ESSENTIALS_TABS = 12;

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

      gZenWorkspaces._resolvePinnedInitialized();
    }

    log(message) {
      if (this._canLog) {
        console.log(`[ZenPinnedTabManager] ${message}`);
      }
    }

    onTabIconChanged(tab, url = null) {
      const iconUrl = url ?? tab.iconImage.src;
      if (!iconUrl && tab.hasAttribute('zen-pin-id')) {
        try {
          setTimeout(async () => {
            const favicon = await this.getFaviconAsBase64(tab.linkedBrowser.currentURI);
            if (favicon) {
              gBrowser.setIcon(tab, favicon);
            }
          });
        } catch {
          // Handle error
        }
      } else {
        if (tab.hasAttribute('zen-essential')) {
          tab.style.setProperty('--zen-essential-tab-icon', `url(${iconUrl})`);
        }
      }
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
      return !gZenWorkspaces.privateWindowOrDisabled;
    }

    async refreshPinnedTabs({ init = false } = {}) {
      if (!this.enabled) {
        return;
      }
      await ZenPinnedTabsStorage.promiseInitialized;
      await gZenWorkspaces.promiseSectionsInitialized;
      await this.#initializePinsCache();
      (async () => {
        // Execute in a separate task to avoid blocking the main thread
        await SessionStore.promiseAllWindowsRestored;
        await gZenWorkspaces.promiseInitialized;
        await this.#initializePinnedTabs(init);
        if (init) {
          this._hasFinishedLoading = true;
        }
      })();
    }

    async #initializePinsCache() {
      try {
        // Get pin data
        const pins = await ZenPinnedTabsStorage.getPins();

        // Enhance pins with favicons
        this._pinsCache = await Promise.all(
          pins.map(async (pin) => {
            try {
              if (pin.isGroup) {
                return pin; // Skip groups for now
              }
              const image = await this.getFaviconAsBase64(Services.io.newURI(pin.url));
              return {
                ...pin,
                iconUrl: image || null,
              };
            } catch {
              // If favicon fetch fails, continue without icon
              return {
                ...pin,
                iconUrl: null,
              };
            }
          })
        );
      } catch (ex) {
        console.error('Failed to initialize pins cache:', ex);
        this._pinsCache = [];
      }

      this.log(`Initialized pins cache with ${this._pinsCache.length} pins`);
      return this._pinsCache;
    }

    async #initializePinnedTabs(init = false) {
      const pins = this._pinsCache;
      if (!pins?.length || !init) {
        return;
      }

      const pinnedTabsByUUID = new Map();
      const pinsToCreate = new Set(pins.map((p) => p.uuid));

      // First pass: identify existing tabs and remove those without pins
      for (let tab of gZenWorkspaces.allStoredTabs) {
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

      for (const group of gZenWorkspaces.allTabGroups) {
        const pinId = group.getAttribute('zen-pin-id');
        if (!pinId) {
          continue;
        }
        if (pinsToCreate.has(pinId)) {
          // This is a valid pinned group that matches a pin
          pinsToCreate.delete(pinId);
        }
      }

      // Second pass: For every existing tab, update its label
      // and set 'zen-has-static-label' attribute if it's been edited
      for (let pin of pins) {
        const tab = pinnedTabsByUUID.get(pin.uuid);
        if (!tab) {
          continue;
        }

        tab.removeAttribute('zen-has-static-label'); // So we can set it again
        if (pin.title && pin.editedTitle) {
          gBrowser._setTabLabel(tab, pin.title, { beforeTabOpen: true });
          tab.setAttribute('zen-has-static-label', 'true');
        }
      }

      const groups = new Map();

      // Third pass: create new tabs for pins that don't have tabs
      for (let pin of pins) {
        try {
          if (!pinsToCreate.has(pin.uuid)) {
            continue; // Skip pins that already have tabs
          }

          if (pin.isGroup) {
            const group = gZenFolders.createFolder([], {
              label: pin.title,
              collapsed: pin.isFolderCollapsed,
              initialPinId: pin.uuid,
              workspaceId: pin.workspaceUuid,
              insertAfter:
                groups.get(pin.parentUuid)?.querySelector('.tab-group-container')?.lastChild ||
                null,
            });
            gZenFolders.setFolderUserIcon(group, pin.folderIcon);
            groups.set(pin.uuid, group);
            continue;
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

          if (pin.parentUuid) {
            const parentGroup = groups.get(pin.parentUuid);
            if (parentGroup) {
              parentGroup.querySelector('.tab-group-container').appendChild(newTab);
            }
          } else {
            if (!pin.isEssential) {
              const container = gZenWorkspaces.workspaceElement(
                pin.workspaceUuid
              )?.pinnedTabsContainer;
              if (container) {
                container.insertBefore(newTab, container.lastChild);
              }
            } else {
              gZenWorkspaces.getEssentialsSection(pin.containerTabId).appendChild(newTab);
            }
          }

          gBrowser.tabContainer._invalidateCachedTabs();
          newTab.initialize();
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
          this.#onTabMove(tab);
          break;
        case 'TabGroupCreate':
          this.#onTabGroupCreate(event);
          break;
        case 'TabGroupRemoved':
          this.#onTabGroupRemoved(event);
          break;
        case 'TabGroupMoved':
          this.#onTabGroupMoved(event);
          break;
        case 'ZenFolderRenamed':
        case 'ZenFolderIconChanged':
        case 'TabGroupCollapse':
        case 'TabGroupExpand':
        case 'ZenFolderChangedWorkspace':
          this.#updateGroupInfo(event.originalTarget);
          break;
        case 'TabGrouped':
          this.#onTabGrouped(event);
          break;
        case 'TabUngrouped':
          this.#onTabUngrouped(event);
          break;
        default:
          console.warn('ZenPinnedTabManager: Unhandled tab event', action);
          break;
      }
    }

    async #onTabGroupCreate(event) {
      const group = event.originalTarget;
      if (!group.isZenFolder) {
        return;
      }
      if (group.hasAttribute('zen-pin-id')) {
        return; // Group already exists in storage
      }
      const workspaceId = group.getAttribute('zen-workspace-id');
      let id = await ZenPinnedTabsStorage.createGroup(
        group.name,
        group.iconURL,
        group.collapsed,
        workspaceId,
        group.getAttribute('zen-pin-id'),
        group.labelElement.elementIndex
      );
      group.setAttribute('zen-pin-id', id);
      await this.refreshPinnedTabs();
    }

    async #onTabGrouped(event) {
      const tab = event.detail;
      const group = tab.group;
      if (!group.isZenFolder) {
        return;
      }
      const pinId = group.getAttribute('zen-pin-id');
      const tabPinId = tab.getAttribute('zen-pin-id');
      const tabPin = this._pinsCache?.find((p) => p.uuid === tabPinId);
      if (!tabPin) {
        return;
      }
      ZenPinnedTabsStorage.addTabToGroup(tabPinId, pinId, /* position */ tab._pPos);
    }

    async #onTabUngrouped(event) {
      const tab = event.detail;
      const group = tab.group;
      if (!group?.isZenFolder) {
        return;
      }
      const tabPinId = tab.getAttribute('zen-pin-id');
      const tabPin = this._pinsCache?.find((p) => p.uuid === tabPinId);
      if (!tabPin) {
        return;
      }
      ZenPinnedTabsStorage.removeTabFromGroup(tabPinId, /* position */ tab._pPos);
    }

    async #updateGroupInfo(group) {
      if (!group?.isZenFolder) {
        return;
      }
      const pinId = group.getAttribute('zen-pin-id');
      const groupPin = this._pinsCache?.find((p) => p.uuid === pinId);
      if (groupPin) {
        groupPin.title = group.name;
        groupPin.folderIcon = group.iconURL;
        groupPin.isFolderCollapsed = group.collapsed;
        groupPin.position = group.labelElement.elementIndex;
        groupPin.parentUuid = group.group?.getAttribute('zen-pin-id') || null;
        groupPin.workspaceUuid = group.getAttribute('zen-workspace-id') || null;
        await this.savePin(groupPin);
        for (const item of group.allItems) {
          if (gBrowser.isTabGroup(item)) {
            await this.#updateGroupInfo(item);
          } else {
            await this.#onTabMove(item);
          }
        }
      }
    }

    async #onTabGroupRemoved(event) {
      const group = event.originalTarget;
      if (!group.isZenFolder) {
        return;
      }
      await ZenPinnedTabsStorage.removePin(group.getAttribute('zen-pin-id'));
      group.removeAttribute('zen-pin-id');
    }

    async #onTabGroupMoved(event) {
      const group = event.originalTarget;
      if (!group.isZenFolder) {
        return;
      }
      const newIndex = group.labelElement.elementIndex;
      const pinId = group.getAttribute('zen-pin-id');
      if (!pinId) {
        return;
      }
      for (const tab of group.tabs) {
        if (tab.pinned && tab.getAttribute('zen-pin-id') === pinId) {
          const pin = this._pinsCache.find((p) => p.uuid === pinId);
          if (pin) {
            pin.position = tab._pPos;
            await this.savePin(pin, false);
          }
          break;
        }
      }
      const groupPin = this._pinsCache?.find((p) => p.uuid === pinId);
      if (groupPin) {
        groupPin.position = newIndex;
        groupPin.parentUuid = group.group?.getAttribute('zen-pin-id');
        await this.savePin(groupPin);
      }
    }

    async #onTabMove(tab) {
      if (!tab.pinned || !this._pinsCache) {
        return;
      }

      const allTabs = [...gBrowser.tabs, ...gBrowser.tabGroups];
      for (let i = 0; i < allTabs.length; i++) {
        const otherTab = allTabs[i];
        if (
          otherTab.pinned &&
          otherTab.getAttribute('zen-pin-id') !== tab.getAttribute('zen-pin-id')
        ) {
          const actualPin = this._pinsCache.find(
            (pin) => pin.uuid === otherTab.getAttribute('zen-pin-id')
          );
          if (!actualPin) {
            continue;
          }
          actualPin.position = otherTab._pPos;
          actualPin.workspaceUuid = otherTab.getAttribute('zen-workspace-id');
          actualPin.parentUuid = otherTab.group?.getAttribute('zen-pin-id') || null;
          await this.savePin(actualPin, false);
        }
      }

      const actualPin = this._pinsCache.find((pin) => pin.uuid === tab.getAttribute('zen-pin-id'));

      if (!actualPin) {
        return;
      }
      actualPin.position = tab._pPos;
      actualPin.isEssential = tab.hasAttribute('zen-essential');
      actualPin.parentUuid = tab.group?.getAttribute('zen-pin-id') || null;
      actualPin.workspaceUuid = tab.getAttribute('zen-workspace-id') || null;

      // There was a bug where the title and hasStaticLabel attribute were not being set
      // This is a workaround to fix that
      if (tab.hasAttribute('zen-has-static-label')) {
        actualPin.editedTitle = true;
        actualPin.title = tab.label;
      }
      await this.savePin(actualPin);
      tab.dispatchEvent(
        new CustomEvent('ZenPinnedTabMoved', {
          detail: { tab },
        })
      );
    }

    async _onTabClick(e) {
      const tab = e.target?.closest('tab');
      if (e.button === 1 && tab) {
        await this._onCloseTabShortcut(e, tab);
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

    async replacePinnedUrlWithCurrent(tab = undefined) {
      tab ??= TabContextMenu.contextTab;
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
      await this.refreshPinnedTabs();
      gZenUIManager.showToast('zen-pinned-tab-replaced');
    }

    async _setPinnedAttributes(tab) {
      if (
        tab.hasAttribute('zen-pin-id') ||
        !this._hasFinishedLoading ||
        tab.hasAttribute('zen-empty-tab')
      ) {
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
        parentUuid: tab.group?.getAttribute('zen-pin-id') || null,
      });

      tab.setAttribute('zen-pin-id', uuid);
      tab.dispatchEvent(
        new CustomEvent('ZenPinnedTabCreated', {
          detail: { tab },
        })
      );

      // This is used while migrating old pins to new system - we don't want to refresh when migrating
      if (tab.getAttribute('zen-pinned-entry')) {
        tab.removeAttribute('zen-pinned-entry');
        return;
      }
      this.onLocationChange(browser);
      await this.refreshPinnedTabs();
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
        tab.removeAttribute('zen-essential'); // Just in case

        if (!tab.hasAttribute('zen-workspace-id') && gZenWorkspaces.workspaceEnabled) {
          const workspace = await gZenWorkspaces.getActiveWorkspace();
          tab.setAttribute('zen-workspace-id', workspace.uuid);
        }
      }
      await this.refreshPinnedTabs();
      tab.dispatchEvent(
        new CustomEvent('ZenPinnedTabRemoved', {
          detail: { tab },
        })
      );
    }

    _initClosePinnedTabShortcut() {
      let cmdClose = document.getElementById('cmd_close');

      if (cmdClose) {
        cmdClose.addEventListener('command', this._onCloseTabShortcut.bind(this));
      }
    }

    async savePin(pin, notifyObservers = true) {
      const existingPin = this._pinsCache.find((p) => p.uuid === pin.uuid);
      if (existingPin) {
        Object.assign(existingPin, pin);
      }
      await ZenPinnedTabsStorage.savePin(pin, notifyObservers);
    }

    async _onCloseTabShortcut(
      event,
      selectedTab = gBrowser.selectedTab,
      behavior = lazy.zenPinnedTabCloseShortcutBehavior
    ) {
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
          if (behavior.includes('unload')) {
            if (selectedTab.hasAttribute('glance-id')) {
              break;
            }
            await gZenFolders.collapseVisibleTab(selectedTab.group, /* only if active */ true);
            await gBrowser.explicitUnloadTabs([selectedTab]);
            selectedTab.removeAttribute('discarded');
          }
          if (selectedTab.selected) {
            this._handleTabSwitch(selectedTab);
          }
          if (behavior.includes('reset')) {
            this._resetTabToStoredState(selectedTab);
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
        gZenWorkspaces.selectEmptyTab();
        return;
      }

      if (nextTab) {
        gBrowser.selectedTab = nextTab;
      }
    }

    _resetTabToStoredState(tab) {
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

      const foundEntryIndex = state.entries?.findIndex((entry) => entry.url === pin.url);
      if (foundEntryIndex === -1) {
        state.entries = [
          {
            url: pin.url,
            title: pin.title,
            triggeringPrincipal_base64: lazy.E10SUtils.SERIALIZED_SYSTEMPRINCIPAL,
          },
        ];
      } else {
        // Remove everything except the entry we want to keep
        const existingEntry = state.entries[foundEntryIndex];
        existingEntry.title = pin.title;
        state.entries = [existingEntry];
      }
      state.image = pin.iconUrl || null;
      state.index = 0;

      SessionStore.setTabState(tab, state);
      this.resetPinChangedUrl(tab);
    }

    async getFaviconAsBase64(pageUrl) {
      try {
        const faviconData = await PlacesUtils.favicons.getFaviconForPage(pageUrl);
        if (!faviconData) {
          // empty favicon
          return 'data:image/png;base64,';
        }
        return faviconData.dataURI;
      } catch (ex) {
        console.error('Failed to get favicon:', ex);
        return null;
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
      let movedAll = true;
      for (let i = 0; i < tabs.length; i++) {
        let tab = tabs[i];
        const section = gZenWorkspaces.getEssentialsSection(tab);
        if (!this.canEssentialBeAdded(tab)) {
          movedAll = false;
          continue;
        }
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
          if (tab.ownerGlobal !== window) {
            tab = gBrowser.adoptTab(tab, {
              selectTab: tab.selected,
            });
            tab.setAttribute('zen-essential', 'true');
          } else {
            section.appendChild(tab);
          }
          gBrowser.tabContainer._invalidateCachedTabs();
        } else {
          gBrowser.pinTab(tab);
        }
        tab.setAttribute('zenDefaultUserContextId', true);
        if (tab.selected) {
          gZenWorkspaces.switchTabIfNeeded(tab);
        }
        this.#onTabMove(tab);
        this.onTabIconChanged(tab);

        // Dispatch the event to update the UI
        const event = new CustomEvent('TabAddedToEssentials', {
          detail: { tab },
        });
        tab.dispatchEvent(event);
      }
      gZenUIManager.updateTabsToolbar();
      return movedAll;
    }

    removeEssentials(tab, unpin = true) {
      const tabs = tab
        ? [tab]
        : TabContextMenu.contextTab.multiselected
          ? gBrowser.selectedTabs
          : [TabContextMenu.contextTab];
      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        tab.removeAttribute('zen-essential');
        if (gZenWorkspaces.workspaceEnabled && gZenWorkspaces.getActiveWorkspaceFromCache().uuid) {
          tab.setAttribute('zen-workspace-id', gZenWorkspaces.getActiveWorkspaceFromCache().uuid);
        }
        if (unpin) {
          gBrowser.unpinTab(tab);
        } else {
          const pinContainer = gZenWorkspaces.pinnedTabsContainer;
          pinContainer.prepend(tab);
          gBrowser.tabContainer._invalidateCachedTabs();
          this.#onTabMove(tab);
        }

        // Dispatch the event to update the UI
        const event = new CustomEvent('TabRemovedFromEssentials', {
          detail: { tab },
        });
        tab.dispatchEvent(event);
      }
      gZenUIManager.updateTabsToolbar();
    }

    _insertItemsIntoTabContextMenu() {
      if (!this.enabled) {
        return;
      }
      const elements = window.MozXULElement.parseXULToFragment(`
            <menuseparator id="context_zen-pinned-tab-separator" hidden="true"/>
            <menuitem id="context_zen-replace-pinned-url-with-current"
                      data-lazy-l10n-id="tab-context-zen-replace-pinned-url-with-current"
                      hidden="true"
                      command="cmd_zenReplacePinnedUrlWithCurrent"/>
            <menuitem id="context_zen-reset-pinned-tab"
                      data-lazy-l10n-id="tab-context-zen-reset-pinned-tab"
                      hidden="true"
                      command="cmd_zenPinnedTabResetNoTab"/>
        `);
      document.getElementById('tabContextMenu').appendChild(elements);

      const element = window.MozXULElement.parseXULToFragment(`
            <menuitem id="context_zen-add-essential"
                      data-l10n-id="tab-context-zen-add-essential"
                      data-l10n-args='{"num": "0"}'
                      hidden="true"
                      disabled="true"
                      command="cmd_contextZenAddToEssentials"/>
            <menuitem id="context_zen-remove-essential"
                      data-lazy-l10n-id="tab-context-zen-remove-essential"
                      hidden="true"
                      command="cmd_contextZenRemoveFromEssentials"/>
        `);

      document.getElementById('context_pinTab')?.before(element);
    }

    updatePinnedTabContextMenu(contextTab) {
      if (!this.enabled) {
        document.getElementById('context_pinTab').hidden = true;
        return;
      }
      const isVisible = contextTab.pinned && !contextTab.multiselected;
      document.getElementById('context_zen-reset-pinned-tab').hidden =
        !isVisible || !contextTab.getAttribute('zen-pin-id');
      document.getElementById('context_zen-replace-pinned-url-with-current').hidden = !isVisible;
      document.getElementById('context_zen-add-essential').hidden =
        contextTab.getAttribute('zen-essential') || !!contextTab.group;
      document.l10n.setArgs(document.getElementById('context_zen-add-essential'), {
        num: gBrowser._numZenEssentials,
      });
      document
        .getElementById('cmd_contextZenAddToEssentials')
        .setAttribute('disabled', !this.canEssentialBeAdded(contextTab));
      document.getElementById('context_zen-remove-essential').hidden =
        !contextTab.getAttribute('zen-essential');
      document.getElementById('context_unpinTab').hidden =
        document.getElementById('context_unpinTab').hidden ||
        contextTab.getAttribute('zen-essential');
      document.getElementById('context_unpinSelectedTabs').hidden =
        document.getElementById('context_unpinSelectedTabs').hidden ||
        contextTab.getAttribute('zen-essential');
      document.getElementById('context_zen-pinned-tab-separator').hidden = !isVisible;
    }

    moveToAnotherTabContainerIfNecessary(event, movingTabs) {
      if (!this.enabled) {
        return false;
      }
      movingTabs = [...movingTabs];
      try {
        const pinnedTabsTarget =
          event.target.closest('.zen-workspace-pinned-tabs-section') ||
          event.target.closest('.zen-current-workspace-indicator') ||
          this._pinnedTabsContainer;
        const essentialTabsTarget = event.target.closest('.zen-essentials-container');
        const tabsTarget = event.target.closest('.zen-workspace-normal-tabs-section');

        // TODO: Solve the issue of adding a tab between two groups
        // Remove group labels from the moving tabs and replace it
        // with the sub tabs
        for (let i = 0; i < movingTabs.length; i++) {
          const draggedTab = movingTabs[i];
          if (gBrowser.isTabGroupLabel(draggedTab)) {
            const group = draggedTab.group;
            // remove label and add sub tabs to moving tabs
            if (group) {
              movingTabs.splice(i, 1, ...group.tabs);
            }
          }
        }

        let isVertical = this.expandedSidebarMode;
        let moved = false;
        let hasActuallyMoved;
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
            if (!draggedTab.hasAttribute('zen-essential') && !draggedTab?.group) {
              moved = true;
              isVertical = false;
              hasActuallyMoved = this.addToEssentials(draggedTab);
            }
          }
          // Check for normal tabs container
          else if (tabsTarget || event.target.id === 'zen-tabs-wrapper') {
            if (
              draggedTab.pinned &&
              !draggedTab.hasAttribute('zen-essential') &&
              !draggedTab?.group?.isZenFolder
            ) {
              gBrowser.unpinTab(draggedTab);
              moved = true;
              isRegularTabs = true;
            } else if (draggedTab.hasAttribute('zen-essential')) {
              this.removeEssentials(draggedTab);
              moved = true;
              isRegularTabs = true;
            }
          }

          if (typeof hasActuallyMoved === 'undefined') {
            hasActuallyMoved = moved;
          }

          // If the tab was moved, adjust its position relative to the target tab
          if (hasActuallyMoved) {
            const targetTab = event.target.closest('.tabbrowser-tab');
            const targetFolder = event.target.closest('zen-folder');
            let targetElem = targetTab || targetFolder?.labelElement;
            if (targetElem?.group?.activeGroups?.length > 0) {
              const activeGroup = targetElem.group.activeGroups.at(-1);
              targetElem = activeGroup.labelElement;
            }
            if (targetElem) {
              const rect = targetElem.getBoundingClientRect();
              let elementIndex = targetElem.elementIndex;

              if (isVertical || !this.expandedSidebarMode) {
                const middleY = targetElem.screenY + rect.height / 2;
                if (!isRegularTabs && event.screenY > middleY) {
                  elementIndex++;
                } else if (isRegularTabs && event.screenY < middleY) {
                  elementIndex--;
                }
              } else {
                const middleX = targetElem.screenX + rect.width / 2;
                if (event.screenX > middleX) {
                  elementIndex++;
                }
              }
              // If it's the last tab, move it to the end
              if (tabsTarget === gBrowser.tabs.at(-1)) {
                elementIndex++;
              }

              gBrowser.moveTabTo(draggedTab, {
                elementIndex,
                forceUngrouped: targetElem?.group?.collapsed !== false,
              });
            }
          }
        }

        return moved;
      } catch (ex) {
        console.error('Error moving tabs:', ex);
        return false;
      }
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
      // Remove # and ? from the URL
      const pinUrl = pin.url.split('#')[0];
      const currentUrl = browser.currentURI.spec.split('#')[0];
      // Add an indicator that the pin has been changed
      if (pinUrl === currentUrl) {
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
      tab.style.setProperty('--zen-original-tab-icon', `url(${pin.iconUrl.spec})`);
    }

    removeTabContainersDragoverClass(hideIndicator = true) {
      if (this._dragIndicator) {
        Services.zen.playHapticFeedback();
      }
      this.dragIndicator.remove();
      this._dragIndicator = null;
      if (hideIndicator) {
        gZenWorkspaces.activeWorkspaceIndicator?.removeAttribute('open');
      }
    }

    onDragFinish() {
      for (const item of this.dragShiftableItems) {
        item.style.transform = '';
      }
      this.removeTabContainersDragoverClass();
    }

    get dragShiftableItems() {
      const separator = gZenWorkspaces.pinnedTabsContainer.querySelector(
        '.pinned-tabs-container-separator'
      );
      // Make sure to always return the separator at the start of the array
      return Services.prefs.getBoolPref('zen.view.show-newtab-button-top')
        ? [separator, gZenWorkspaces.activeWorkspaceElement.newTabButton]
        : [separator];
    }

    animateSeparatorMove(draggedTab, dropElement, isPinned) {
      if (draggedTab?.group?.hasAttribute('split-view-group')) {
        draggedTab = draggedTab.group;
      }
      const itemsToCheck = this.dragShiftableItems;
      const separator = itemsToCheck[0];
      const separatorRect = window.windowUtils.getBoundsWithoutFlushing(separator);
      const tabRect = window.windowUtils.getBoundsWithoutFlushing(draggedTab);
      const translate = tabRect.top - tabRect.height / 2 + separatorRect.height / 2;
      const topToNormalTabs = separatorRect.top - separatorRect.height / 2;
      const isGoingToPinnedTabs = translate < topToNormalTabs;
      const multiplier = isGoingToPinnedTabs !== isPinned ? (isGoingToPinnedTabs ? 1 : -1) : 0;
      const draggingTabHeight =
        window.windowUtils.getBoundsWithoutFlushing(draggedTab).height * multiplier;
      this._isGoingToPinnedTabs = isGoingToPinnedTabs;
      if (!dropElement) {
        itemsToCheck.forEach((item) => {
          item.style.transform = `translateY(${draggingTabHeight}px)`;
        });
      }
    }

    getLastTabBound(lastBound, lastTab, isDraggingFolder = false) {
      if (!gBrowser.isTab(lastTab) || !lastTab.pinned || isDraggingFolder) {
        return lastBound;
      }
      const shiftedItems = this.dragShiftableItems;
      let totalHeight = shiftedItems.reduce((acc, item) => {
        return acc + window.windowUtils.getBoundsWithoutFlushing(item).height;
      }, 0);
      if (shiftedItems.length === 1) {
        // Means the new tab button is not at the top or not visible
        const lastTabRect = window.windowUtils.getBoundsWithoutFlushing(lastTab);
        totalHeight += lastTabRect.height;
      }
      return lastBound + totalHeight + 6;
    }

    get dragIndicator() {
      if (!this._dragIndicator) {
        this._dragIndicator = document.createElement('div');
        this._dragIndicator.id = 'zen-drag-indicator';
        gNavToolbox.appendChild(this._dragIndicator);
      }
      return this._dragIndicator;
    }

    get expandedSidebarMode() {
      return document.documentElement.getAttribute('zen-sidebar-expanded') === 'true';
    }

    async updatePinTitle(tab, newTitle, isEdited = true, notifyObservers = true) {
      const uuid = tab.getAttribute('zen-pin-id');
      await ZenPinnedTabsStorage.updatePinTitle(uuid, newTitle, isEdited, notifyObservers);

      await this.refreshPinnedTabs();

      const browsers = Services.wm.getEnumerator('navigator:browser');

      // update the label for the same pin across all windows
      for (const browser of browsers) {
        const tabs = browser.gBrowser.tabs;
        // Fix pinned cache for the browser
        const browserCache = browser.gZenPinnedTabManager?._pinsCache;
        if (browserCache) {
          const pin = browserCache.find((pin) => pin.uuid === uuid);
          if (pin) {
            pin.title = newTitle;
            pin.editedTitle = isEdited;
          }
        }
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

    canEssentialBeAdded(tab) {
      return (
        !(
          (tab.getAttribute('usercontextid') || 0) !=
            gZenWorkspaces.getActiveWorkspaceFromCache().containerTabId &&
          gZenWorkspaces.containerSpecificEssentials
        ) && gBrowser._numZenEssentials < this.MAX_ESSENTIALS_TABS
      );
    }

    applyDragoverClass(event, draggedTab) {
      if (!this.enabled) {
        return;
      }
      if (
        gBrowser.isTabGroupLabel(draggedTab) &&
        !draggedTab?.group?.hasAttribute('split-view-group')
      ) {
        // If the target is a tab group label, we don't want to apply the dragover class
        this.removeTabContainersDragoverClass();
        return;
      }
      const folderTarget = event.target.closest('zen-folder');
      const pinnedTabsTarget = event.target.closest('.zen-workspace-pinned-tabs-section');
      const essentialTabsTarget = event.target.closest('.zen-essentials-container');
      const tabsTarget = event.target.closest('.zen-workspace-normal-tabs-section');
      let targetTab = event.target.closest('.tabbrowser-tab');
      targetTab = targetTab?.group || targetTab;
      draggedTab = draggedTab?.group?.hasAttribute('split-view-group')
        ? draggedTab.group
        : draggedTab;
      const isHoveringIndicator = !!event.target.closest('.zen-current-workspace-indicator');
      if (isHoveringIndicator) {
        this.removeTabContainersDragoverClass(false);
        gZenWorkspaces.activeWorkspaceIndicator?.setAttribute('open', true);
      } else {
        gZenWorkspaces.activeWorkspaceIndicator?.removeAttribute('open');
      }

      if (draggedTab) {
        gZenFolders.ungroupTabFromActiveGroups(draggedTab);
      }

      let shouldAddDragOverElement = false;
      let isVertical = this.expandedSidebarMode;

      // Decide whether we should show a dragover class for the given target
      if (pinnedTabsTarget) {
        if (draggedTab.hasAttribute('zen-essential')) {
          shouldAddDragOverElement = true;
        } else if (!draggedTab.pinned) {
          Services.zen.playHapticFeedback();
        }
      } else if (essentialTabsTarget) {
        if (!draggedTab.hasAttribute('zen-essential') && this.canEssentialBeAdded(draggedTab)) {
          shouldAddDragOverElement = true;
          isVertical = false;
        }
      } else if (tabsTarget) {
        if (draggedTab.hasAttribute('zen-essential')) {
          shouldAddDragOverElement = true;
        } else if (draggedTab.pinned) {
          Services.zen.playHapticFeedback();
        }
      }

      if (!shouldAddDragOverElement || (!targetTab && !folderTarget) || !targetTab) {
        this.removeTabContainersDragoverClass(!isHoveringIndicator);
        return;
      }

      // Calculate middle to decide 'before' or 'after'
      const rect = targetTab.getBoundingClientRect();
      let shouldPlayHapticFeedback = false;
      if (isVertical || !this.expandedSidebarMode) {
        const separation = 8;
        const middleY = targetTab.screenY + rect.height / 2;
        const indicator = this.dragIndicator;
        let top = 0;
        if (event.screenY > middleY) {
          top = Math.round(rect.top + rect.height) + 'px';
        } else {
          top = Math.round(rect.top) + 'px';
        }
        if (indicator.style.top !== top) {
          shouldPlayHapticFeedback = true;
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
          left = Math.round(rect.left + rect.width + 1) + 'px';
        } else {
          left = Math.round(rect.left - 2) + 'px';
        }
        if (indicator.style.left !== left) {
          shouldPlayHapticFeedback = true;
        }
        indicator.setAttribute('orientation', 'vertical');
        indicator.style.setProperty('--indicator-top', rect.top + separation / 2 + 'px');
        indicator.style.setProperty('--indicator-height', rect.height - separation + 'px');
        indicator.style.left = left;
        indicator.style.removeProperty('top');
      }
      if (shouldPlayHapticFeedback) {
        Services.zen.playHapticFeedback();
      }
    }

    async onTabLabelChanged(tab) {
      if (!this._pinsCache) {
        return;
      }
      // If our current pin in the cache point to about:blank, we need to update the entry
      const pin = this._pinsCache.find((pin) => pin.uuid === tab.getAttribute('zen-pin-id'));
      if (!pin) {
        return;
      }

      if (pin.url === 'about:blank' && tab.linkedBrowser.currentURI.spec !== 'about:blank') {
        await this.replacePinnedUrlWithCurrent(tab);
      }
    }
  }

  window.gZenPinnedTabManager = new nsZenPinnedTabManager();
}
