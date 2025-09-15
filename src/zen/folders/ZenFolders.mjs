// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
{
  function formatRelativeTime(timestamp) {
    const now = Date.now();

    const sec = Math.floor((now - timestamp) / 1000);
    if (sec < 60) {
      return 'Just now';
    }

    const min = Math.floor(sec / 60);
    if (min < 60) {
      return `${min} minute${min === 1 ? '' : 's'} ago`;
    }

    const hour = Math.floor(min / 60);
    if (hour < 24) {
      return `${hour} hour${hour === 1 ? '' : 's'} ago`;
    }

    const day = Math.floor(hour / 24);
    if (day < 30) {
      return `${day} day${day === 1 ? '' : 's'} ago`;
    }

    const month = Math.floor(day / 30);
    return `${month} month${month === 1 ? '' : 's'} ago`;
  }

  const ZEN_MAX_SUBFOLDERS = Services.prefs.getIntPref('zen.folders.max-subfolders');

  class nsZenFolders extends nsZenDOMOperatedFeature {
    #popup = null;
    #popupTimer = null;
    #mouseTimer = null;
    #lastHighlightedGroup = null;

    #lastFolderContextMenu = null;

    #foldersEnabled = false;
    #folderAnimCache = new Map();

    #animationCount = 0;

    init() {
      this.#foldersEnabled = !gZenWorkspaces.privateWindowOrDisabled;

      if (!this.#foldersEnabled) {
        return;
      }

      this.#initContextMenu();
      this.#initTabsPopup();
      this.#initEventListeners();
    }

    #initContextMenu() {
      const contextMenuItems = window.MozXULElement.parseXULToFragment(
        `<menuitem id="zen-context-menu-new-folder" data-l10n-id="zen-toolbar-context-new-folder"/>`
      );
      document.getElementById('context_moveTabToGroup').before(contextMenuItems);
      const contextMenuItemsToolbar = window.MozXULElement.parseXULToFragment(
        `<menuitem id="zen-context-menu-new-folder-toolbar" data-l10n-id="zen-toolbar-context-new-folder"/>`
      );
      document.getElementById('toolbar-context-openANewTab').after(contextMenuItemsToolbar);

      const folderActionsMenu = document.getElementById('zenFolderActions');
      folderActionsMenu.addEventListener('popupshowing', (event) => {
        const target = event.explicitOriginalTarget;
        let folder;
        if (gBrowser.isTabGroupLabel(target)) {
          folder = target.group;
        } else if (gBrowser.isTabGroupLabel(target.parentElement)) {
          folder = target.parentElement.group;
        } else if (
          target.parentElement?.isZenFolder &&
          target?.classList.contains('tab-group-label-container')
        ) {
          folder = target.parentElement;
        }

        // We only want to rename zen-folders as firefox groups don't work well with this
        if (!folder?.isZenFolder) {
          return;
        }
        this.#lastFolderContextMenu = folder;

        const newSubfolderItem = document.getElementById('context_zenFolderNewSubfolder');
        newSubfolderItem.setAttribute(
          'disabled',
          folder.level >= ZEN_MAX_SUBFOLDERS - 1 ? 'true' : 'false'
        );

        const changeFolderSpace = document
          .getElementById('context_zenChangeFolderSpace')
          .querySelector('menupopup');
        changeFolderSpace.innerHTML = '';
        for (const workspace of [...gZenWorkspaces._workspaceCache.workspaces].reverse()) {
          const item = document.createXULElement('menuitem');
          item.className = 'zen-workspace-context-menu-item';
          item.setAttribute('zen-workspace-id', workspace.uuid);
          item.setAttribute('disabled', workspace.uuid === gZenWorkspaces.activeWorkspace);
          let name = workspace.name;
          const iconIsSvg = workspace.icon && workspace.icon.endsWith('.svg');
          if (workspace.icon && workspace.icon !== '' && !iconIsSvg) {
            name = `${workspace.icon}  ${name}`;
          }
          item.setAttribute('label', name);
          if (iconIsSvg) {
            item.setAttribute('image', workspace.icon);
            item.classList.add('zen-workspace-context-icon');
          }
          item.addEventListener('command', (event) => {
            if (!this.#lastFolderContextMenu) return;
            this.changeFolderToSpace(
              this.#lastFolderContextMenu,
              event.target.closest('menuitem').getAttribute('zen-workspace-id')
            );
          });
          changeFolderSpace.appendChild(item);
        }
      });

      folderActionsMenu.addEventListener(
        'popuphidden',
        (event) => {
          if (event.target === folderActionsMenu) {
            this.#lastFolderContextMenu = null;
          }
        },
        { once: true }
      );

      folderActionsMenu.addEventListener('command', (event) => {
        if (!this.#lastFolderContextMenu) return;
        switch (event.target.id) {
          case 'context_zenFolderRename':
            this.#lastFolderContextMenu.rename();
            break;
          case 'context_zenFolderUnpack':
            this.#lastFolderContextMenu.unpackTabs();
            break;
          case 'context_zenFolderUnloadAll':
            this.#lastFolderContextMenu.unloadAllTabs(event);
            break;
          case 'context_zenFolderNewSubfolder':
            this.#lastFolderContextMenu.createSubfolder();
            break;
          case 'context_zenFolderDelete':
            this.#lastFolderContextMenu.delete();
            break;
          case 'context_zenFolderToSpace':
            this.#convertFolderToSpace(this.#lastFolderContextMenu);
            break;
          case 'context_zenFolderChangeIcon':
            this.changeFolderUserIcon(this.#lastFolderContextMenu);
            break;
        }
      });
    }

    #initTabsPopup() {
      this.#popup = document.getElementById('zen-folder-tabs-popup');

      const search = this.#popup.querySelector('#zen-folder-tabs-list-search');
      const tabsList = this.#popup.querySelector('#zen-folder-tabs-list');

      search.addEventListener('input', () => {
        const query = search.value.toLowerCase();
        for (const item of tabsList.children) {
          item.hidden = !item.getAttribute('data-label').includes(query);
        }
      });

      this.#popup.addEventListener('mouseover', () => {
        clearTimeout(this.#popupTimer);
      });

      this.#popup.addEventListener('mouseout', () => {
        this.#popupTimer = setTimeout(() => {
          if (this.#popup.matches(':hover')) return;
          this.#popup.hidePopup();
        }, 200);
      });
    }

    #initEventListeners() {
      window.addEventListener('TabGrouped', this);
      window.addEventListener('TabUngrouped', this);
      window.addEventListener('TabGroupCreate', this);
      window.addEventListener('TabPinned', this);
      window.addEventListener('TabUnpinned', this);
      window.addEventListener('TabGroupExpand', this);
      window.addEventListener('TabGroupCollapse', this);
      window.addEventListener('FolderGrouped', this);
      window.addEventListener('FolderUngrouped', this);
      window.addEventListener('TabSelect', this);
      window.addEventListener('TabOpen', this);
      const onNewFolder = this.#onNewFolder.bind(this);
      document
        .getElementById('zen-context-menu-new-folder')
        .addEventListener('command', onNewFolder);
      document
        .getElementById('zen-context-menu-new-folder-toolbar')
        .addEventListener('command', onNewFolder);
      SessionStore.promiseInitialized.then(() => {
        gBrowser.tabContainer.addEventListener('dragstart', this.cancelPopupTimer.bind(this));
      });
    }

    handleEvent(aEvent) {
      let methodName = `on_${aEvent.type}`;
      if (methodName in this) {
        this[methodName](aEvent);
      } else {
        throw new Error(`Unexpected event ${aEvent.type}`);
      }
    }

    on_TabGrouped(event) {
      const tab = event.detail;
      const group = tab.group;
      group.pinned = tab.pinned;
      const isActiveFolder = group?.activeGroups?.length > 0;

      if (isActiveFolder) {
        group.activeTabs = [...new Set([...group.activeTabs, tab])].sort(
          (a, b) => a._tPos > b._tPos
        );
      }

      if (group.hasAttribute('split-view-group') && group.hasAttribute('zen-pinned-changed')) {
        // zen-pinned-changed remove it and set it to had-zen-pinned-changed to keep
        // track of the original pinned state
        group.removeAttribute('zen-pinned-changed');
        group.setAttribute('had-zen-pinned-changed', true);
      }

      if (group.collapsed && !this._sessionRestoring) {
        group.collapsed = group.hasAttribute('has-active');
      }
    }

    on_FolderGrouped(event) {
      if (this._sessionRestoring) return;
      const folder = event.detail;
      const parentFolder = event.target;
      const isActiveFolder = parentFolder?.activeGroups?.length > 0;
      const isSplitView = folder.hasAttribute('split-view-group');
      if (isActiveFolder && isSplitView) {
        parentFolder.activeTabs = [...new Set([...parentFolder.activeTabs, ...folder.tabs])].sort(
          (a, b) => a._tPos > b._tPos
        );
      }
      parentFolder.collapsed = isActiveFolder;
    }

    on_FolderUngrouped(event) {
      if (this._sessionRestoring) return;
      const parentFolder = event.target;
      const folder = event.detail;
      for (const tab of folder.tabs) {
        this.animateUnload(parentFolder, tab, true);
      }
    }

    async on_TabSelect(event) {
      const tab = gZenGlanceManager.getTabOrGlanceParent(event.target);
      let group = tab?.group;
      if (group?.hasAttribute('split-view-group')) group = group?.group;
      if (!group?.isZenFolder) {
        return;
      }

      const collapsedRoot = group.rootMostCollapsedFolder;
      if (!collapsedRoot) {
        return;
      }

      collapsedRoot.setAttribute('has-active', 'true');
      await this.animateSelect(collapsedRoot);
      gBrowser.tabContainer._invalidateCachedTabs();
    }

    on_TabOpen(event) {
      const tab = event.target;
      const group = tab.group;
      if (!group?.isZenFolder || tab.pinned) return;
      // Edge case: In occations where we add a tab with an ownerTab
      // inside a folder, the tab gets added into the folder in an
      // unpinned state. We need to pin it and re-add it into the folder.
      if (Services.prefs.getBoolPref('zen.folders.owned-tabs-in-folder')) {
        gBrowser.pinTab(tab);
        group.addTabs([tab]);
      }
    }

    async on_TabUngrouped(event) {
      const tab = event.detail;
      const group = event.target;
      if (group.hasAttribute('split-view-group') && tab.hasAttribute('had-zen-pinned-changed')) {
        tab.setAttribute('zen-pinned-changed', true);
        tab.removeAttribute('had-zen-pinned-changed');
      }

      await this.animateUnload(group, tab, true);
    }

    on_TabGroupCreate(event) {
      const group = event.target;
      const tabs = group.tabs;
      if (!group.pinned) {
        return;
      }
      for (const tab of tabs) {
        if (tab.hasAttribute('zen-pinned-changed')) {
          tab.removeAttribute('zen-pinned-changed');
          tab.setAttribute('had-zen-pinned-changed', true);
        }
      }
    }

    on_TabPinned(event) {
      const tab = event.target;
      const group = tab.group;
      if (group && group.hasAttribute('split-view-group')) {
        group.pinned = true;
      }
    }

    on_TabUnpinned(event) {
      const tab = event.target;
      const group = tab.group;
      if (group && group.hasAttribute('split-view-group')) {
        group.pinned = false;
      }
    }

    cancelPopupTimer() {
      if (this.#mouseTimer) {
        clearTimeout(this.#mouseTimer);
        this.#mouseTimer = null;
      }
      if (this.#popup) {
        this.#popup.hidePopup();
      }
    }

    async on_TabGroupCollapse(event) {
      const group = event.target;
      if (!group.isZenFolder) return;

      this.cancelPopupTimer();
      await this.animateCollapse(group);
    }

    async on_TabGroupExpand(event) {
      const group = event.target;
      if (!group.isZenFolder) return;

      this.cancelPopupTimer();
      await this.animateExpand(group);
    }

    #onNewFolder(event) {
      const isFromToolbar = event.target.id === 'zen-context-menu-new-folder-toolbar';
      const contextMenu = event.target.parentElement;
      let tabs = TabContextMenu.contextTab?.multiselected
        ? gBrowser.selectedTabs
        : [TabContextMenu.contextTab];
      let triggerTab =
        contextMenu.triggerNode &&
        (contextMenu.triggerNode.tab || contextMenu.triggerNode.closest('tab'));

      const selectedTabs = gBrowser.selectedTabs;
      if (selectedTabs.length > 1) {
        tabs.push(triggerTab, ...gBrowser.selectedTabs);
      } else {
        tabs.push(triggerTab);
      }
      if (isFromToolbar) {
        tabs = [];
      }

      const canInsertBefore =
        !isFromToolbar &&
        !triggerTab.hasAttribute('zen-essential') &&
        !triggerTab?.group?.hasAttribute('split-view-group') &&
        this.canDropElement({ isZenFolder: true }, triggerTab);

      this.createFolder(tabs, {
        insertAfter: !canInsertBefore ? triggerTab?.group : null,
        insertBefore: canInsertBefore ? triggerTab : null,
        renameFolder: true,
      });
    }

    async #convertFolderToSpace(folder) {
      const currentWorkspace = gZenWorkspaces.getActiveWorkspaceFromCache();
      let selectedTab = folder.tabs.find((tab) => tab.selected);
      const icon = folder.icon?.querySelector('svg #folder-icon image');

      const newSpace = await gZenWorkspaces.createAndSaveWorkspace(
        folder.label,
        /* icon= */ icon?.getAttribute('href'),
        /* dontChange= */ false,
        currentWorkspace.containerTabId,
        {
          beforeChangeCallback: async (newWorkspace) => {
            await new Promise((resolve) => {
              requestAnimationFrame(async () => {
                const workspacePinnedContainer = gZenWorkspaces.workspaceElement(
                  newWorkspace.uuid
                ).pinnedTabsContainer;
                const tabs = folder.allItems.filter((tab) => !tab.hasAttribute('zen-empty-tab'));
                workspacePinnedContainer.append(...tabs);
                await folder.delete();
                gBrowser.tabContainer._invalidateCachedTabs();
                if (selectedTab) {
                  selectedTab.setAttribute('zen-workspace-id', newWorkspace.uuid);
                  selectedTab.removeAttribute('folder-active');
                  gZenWorkspaces._lastSelectedWorkspaceTabs[newWorkspace.uuid] = selectedTab;
                }
                resolve();
              });
            });
          },
        }
      );
      // Change the ID for all tabs
      for (const tab of gBrowser.tabs) {
        if (!tab.hasAttribute('zen-essential')) {
          tab.setAttribute('zen-workspace-id', newSpace.uuid);
          tab.style.opacity = '';
          tab.style.height = '';
        }
        gBrowser.TabStateFlusher.flush(tab.linkedBrowser);
        if (gZenWorkspaces._lastSelectedWorkspaceTabs[currentWorkspace.uuid] === tab) {
          // This tab is no longer the last selected tab in the previous workspace because it's being moved to
          // the current workspace
          delete gZenWorkspaces._lastSelectedWorkspaceTabs[currentWorkspace.uuid];
        }
      }
    }

    changeFolderToSpace(folder, workspaceId) {
      const currentWorkspace = gZenWorkspaces.getActiveWorkspaceFromCache();
      if (currentWorkspace.uuid === workspaceId) {
        return;
      }
      const workspaceElement = gZenWorkspaces.workspaceElement(workspaceId);
      const pinnedTabsContainer = workspaceElement.pinnedTabsContainer;
      pinnedTabsContainer.insertBefore(folder, pinnedTabsContainer.lastChild);
      for (const tab of folder.tabs) {
        tab.setAttribute('zen-workspace-id', workspaceId);
        // This sets the ID for the current folder and any sub-folder
        // we may encounter
        tab.group.setAttribute('zen-workspace-id', workspaceId);
        gBrowser.TabStateFlusher.flush(tab.linkedBrowser);
        if (gZenWorkspaces._lastSelectedWorkspaceTabs[workspaceId] === tab) {
          // This tab is no longer the last selected tab in the previous workspace because it's being moved to a new workspace
          delete gZenWorkspaces._lastSelectedWorkspaceTabs[workspaceId];
        }
      }
      folder.dispatchEvent(new CustomEvent('ZenFolderChangedWorkspace', { bubbles: true }));
      gZenWorkspaces.changeWorkspaceWithID(workspaceId).then(() => {
        gBrowser.moveTabTo(folder, { elementIndex: 0, forceUngrouped: true });
      });
    }

    canDropElement(element, targetElement) {
      const isZenFolder = element?.isZenFolder;
      const level = targetElement?.group?.level + 1;
      if (isZenFolder && level >= ZEN_MAX_SUBFOLDERS) {
        return false;
      }
      return true;
    }

    createFolder(tabs = [], options = {}) {
      const filteredTabs = tabs
        .filter((tab) => !tab.hasAttribute('zen-essential'))
        .map((tab) => {
          gBrowser.pinTab(tab);
          if (tab?.group?.hasAttribute('split-view-group')) {
            tab = tab.group;
          }
          return tab;
        });

      const workspacePinned = gZenWorkspaces.workspaceElement(
        options.workspaceId
      )?.pinnedTabsContainer;
      const pinnedContainer =
        options.workspaceId && workspacePinned
          ? workspacePinned
          : gZenWorkspaces.pinnedTabsContainer;
      const insertBefore =
        options.insertBefore || pinnedContainer.querySelector('.pinned-tabs-container-separator');
      const emptyTab = gBrowser.addTab('about:blank', {
        skipAnimation: true,
        pinned: true,
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        _forZenEmptyTab: true,
        createLazyBrowser: true,
      });

      gBrowser.pinTab(emptyTab);
      tabs = [emptyTab, ...filteredTabs];

      const folder = this._createFolderNode(options);
      if (options.initialPinId) {
        folder.setAttribute('zen-pin-id', options.initialPinId);
      }

      if (options.insertAfter) {
        options.insertAfter.after(folder);
      } else {
        insertBefore.before(folder);
      }
      gZenVerticalTabsManager.animateItemOpen(folder);

      folder.addTabs(tabs);

      // Fixes bug1953801 and bug1954689
      // Ensure that the tab state cache is updated immediately after creating
      // a group. This is necessary because we consider group creation a
      // deliberate user action indicating the tab has importance for the user.
      // Without this, it is not possible to save and close a tab group with
      // a short lifetime.
      folder.tabs.forEach((tab) => {
        gBrowser.TabStateFlusher.flush(tab.linkedBrowser);
      });

      this.updateFolderIcon(folder, 'auto', false);

      if (options.renameFolder) {
        folder.rename();
      }

      this.#groupInit(folder);
      return folder;
    }

    _createFolderNode(options = {}) {
      const folder = document.createXULElement('zen-folder', { is: 'zen-folder' });
      let id = options.id;
      if (!id) {
        // Note: If this changes, make sure to also update the
        // getExtTabGroupIdForInternalTabGroupId implementation in
        // browser/components/extensions/parent/ext-browser.js.
        // See: Bug 1960104 - Improve tab group ID generation in addTabGroup
        id = `${Date.now()}-${Math.round(Math.random() * 100)}`;
      }
      folder.id = id;
      folder.label = options.label || 'New Folder';
      folder.saveOnWindowClose = !!options.saveOnWindowClose;
      folder.color = 'zen-workspace-color';

      folder.setAttribute(
        'zen-workspace-id',
        options.workspaceId || gZenWorkspaces.activeWorkspace
      );

      // note: We set if the folder is collapsed some time after creation.
      //   we do this to ensure marginBottom is set correctly in the case
      //   that we want it to initially be collapsed.
      setTimeout(
        (folder) => {
          gZenPinnedTabManager.promiseInitializedPinned.then(() => {
            folder.collapsed = !!options.collapsed;
          });
        },
        0,
        folder
      );
      return folder;
    }

    handleTabPin(tab) {
      const group = tab.group;
      if (!group) {
        return false;
      }
      if (group.hasAttribute('split-view-group') && !this._piningFolder) {
        this._piningFolder = true;
        for (const otherTab of group.tabs) {
          gZenPinnedTabManager.resetPinChangedUrl(otherTab);
          if (tab === otherTab) {
            continue;
          }
          gBrowser.pinTab(otherTab);
        }
        this._piningFolder = false;
        gBrowser.pinnedTabsContainer.insertBefore(group, gBrowser.pinnedTabsContainer.lastChild);
        gBrowser.tabContainer._invalidateCachedTabs();
        return true;
      }
      return this._piningFolder;
    }

    handleTabUnpin(tab) {
      tab.style.removeProperty('--zen-folder-indent');
      const group = tab.group;
      if (!group) {
        return false;
      }
      if (group.hasAttribute('split-view-group') && !this._piningFolder) {
        this._piningFolder = true;
        for (const otherTab of group.tabs) {
          if (tab === otherTab) {
            continue;
          }
          gBrowser.unpinTab(otherTab);
        }
        this._piningFolder = false;
        gZenWorkspaces.activeWorkspaceStrip.prepend(group);
        gBrowser.tabContainer._invalidateCachedTabs();
        return true;
      }
      return this._piningFolder;
    }

    openTabsPopup(event) {
      event.stopPropagation();
      if (document.documentElement.getAttribute('zen-renaming-tab')) {
        return;
      }

      const activeGroup = event.target.parentElement;
      if (
        activeGroup.tabs.filter((tab) => this.#shouldAppearOnTabSearch(tab, activeGroup)).length ===
        0
      ) {
        // If the group has no tabs, we don't show the popup
        return;
      }
      document.getElementById('zen-folder-tabs-search-no-results').hidden = true;
      this.#populateTabsList(activeGroup);

      const search = this.#popup.querySelector('#zen-folder-tabs-list-search');
      document.l10n.setArgs(search, {
        'folder-name': activeGroup.name,
      });
      const tabsList = this.#popup.querySelector('#zen-folder-tabs-list');

      const onSearchInput = () => {
        const query = search.value.toLowerCase();
        let foundTabs = 0;
        for (const item of tabsList.children) {
          const found = item.getAttribute('data-label').includes(query);
          item.hidden = !found;
          if (found) {
            foundTabs++;
          }
        }
        document.getElementById('zen-folder-tabs-search-no-results').hidden = foundTabs > 0;
      };
      search.addEventListener('input', onSearchInput);

      const onKeyDown = (event) => {
        // Arrow down and up to navigate through the list
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const items = Array.from(tabsList.children).filter((item) => !item.hidden);
          if (items.length === 0) return;
          let index = items.indexOf(tabsList.querySelector('.folders-tabs-list-item[selected]'));
          if (event.key === 'ArrowDown') {
            index = (index + 1) % items.length;
          } else if (event.key === 'ArrowUp') {
            index = (index - 1 + items.length) % items.length;
          }
          items.forEach((item) => item.removeAttribute('selected'));
          const targetItem = items[index];
          targetItem.setAttribute('selected', 'true');
          targetItem.scrollIntoView({ block: 'start', behavior: 'smooth' });
        } else if (event.key === 'Enter') {
          // Enter to select the currently highlighted item
          const highlightedItem = tabsList.querySelector('.folders-tabs-list-item[selected]');
          if (highlightedItem) {
            highlightedItem.click();
          }
        }
      };
      document.addEventListener('keydown', onKeyDown);

      const target = event.target;
      target.setAttribute('open', true);

      const handlePopupHidden = (event) => {
        if (event.target !== this.#popup) return;
        search.value = '';
        target.removeAttribute('open');
        search.removeEventListener('input', onSearchInput);
        document.removeEventListener('keydown', onKeyDown);
      };

      this.#popup.addEventListener(
        'popupshown',
        () => {
          search.focus();
          search.select();
        },
        { once: true }
      );

      this.#popup.addEventListener('popuphidden', handlePopupHidden, { once: true });
      this.#popup.openPopup(target, this.#searchPopupOptions);
    }

    get #searchPopupOptions() {
      const isRightSide = gZenVerticalTabsManager._prefsRightSide;
      const position = isRightSide ? 'topleft topright' : 'topright topleft';
      return {
        position: position,
        x: 5,
        y: -25,
      };
    }

    #shouldAppearOnTabSearch(tab, group) {
      // Note that tab.visible and tab.hidden act in different ways.
      // We don't want to show already visible tabs in the search results.
      // That's why we need to do the active tab search, tab.hidden doesn't
      // account for the visibility of the tab itself, it's just a literal
      // representation of the `hidden` attribute.
      const tabIsInActiveGroup = group.activeTabs.includes(tab);
      return !tabIsInActiveGroup && !(tab.hidden || tab.hasAttribute('zen-empty-tab'));
    }

    #populateTabsList(group) {
      const tabsList = this.#popup.querySelector('#zen-folder-tabs-list');
      tabsList.replaceChildren();

      for (const tab of group.tabs) {
        if (!this.#shouldAppearOnTabSearch(tab, group)) continue;

        const item = document.createElement('div');
        item.className = 'folders-tabs-list-item';

        const content = document.createElement('div');
        content.className = 'folders-tabs-list-item-content';

        const icon = document.createElement('img');
        icon.className = 'folders-tabs-list-item-icon';

        let tabURL = tab.linkedBrowser?.currentURI?.spec || '';
        try {
          // Get the hostname from the URL
          const url = new URL(tabURL);
          tabURL = url.hostname || tabURL;
        } catch {
          // We don't need to do anything if the URL is invalid. e.g. about:blank
        }
        let tabLabel = tab.label || '';
        let iconURL = gBrowser.getIcon(tab) || PlacesUtils.favicons.defaultFavicon.spec;

        icon.src = iconURL;

        const labelsContainer = document.createElement('div');
        labelsContainer.className = 'folders-tabs-list-item-labels';

        const mainLabel = document.createElement('div');
        mainLabel.className = 'folders-tabs-list-item-label';
        mainLabel.textContent = tabLabel;

        const secondaryLabel = document.createElement('div');
        secondaryLabel.className = 'tab-list-item-secondary-label';
        secondaryLabel.textContent = `${formatRelativeTime(tab.lastAccessed)} • ${tab.group.label}`;

        labelsContainer.append(mainLabel, secondaryLabel);
        content.append(icon, labelsContainer);
        item.append(content);

        if (tab.selected) {
          item.setAttribute('selected', 'true');
        }

        item.setAttribute('data-label', `${tabLabel.toLowerCase()} ${tabURL.toLowerCase()}`);

        item.addEventListener('click', () => {
          gBrowser.selectedTab = tab;
        });

        item.addEventListener('mouseenter', () => {
          for (const sibling of tabsList.children) {
            sibling.removeAttribute('selected');
          }
          item.setAttribute('selected', 'true');
        });

        tabsList.appendChild(item);
      }
    }

    updateFolderIcon(group, state = 'auto', play = true) {
      const svg = group.querySelector('svg');
      if (!svg) return [];
      let animations = this.#folderAnimCache.get(group);
      if (!animations) {
        animations = svg.querySelectorAll('animate, animateTransform, animateMotion');
        this.#folderAnimCache.set(group, animations);
      }

      const isCollapsed = group.collapsed;
      svg.setAttribute('state', state === 'auto' ? (isCollapsed ? 'close' : 'open') : state);
      const hasActive = group.hasAttribute('has-active');

      const OPACITY = {
        'folder-dots': { active: '0;1', baseOrig: '0;0' },
        'folder-icon': { active: '1;0', baseOrig: '1;1' },
      };

      animations.forEach((animation) => {
        const parentId = animation.parentElement.id;
        const isOpacity = animation.getAttribute('attributeName') === 'opacity';

        if (!animation.dataset.origValues) {
          animation.dataset.origValues = animation.getAttribute('values');
        }

        const origValues = animation.dataset.origValues;
        const [fromValue, toValue] = origValues.split(';');

        const isActiveState = isCollapsed && hasActive && isOpacity;

        if (!play && !isActiveState) {
          if (isOpacity && OPACITY[parentId]) {
            const staticValue = OPACITY[parentId].baseOrig;
            animation.dataset.origValues = staticValue;
            animation.setAttribute('values', staticValue);
            animation.beginElement();
          }
          return;
        }

        if (isOpacity && OPACITY[parentId]) {
          animation.dataset.origValues = OPACITY[parentId].baseOrig;
        }

        let newValues;

        if (isActiveState && OPACITY[parentId]) {
          newValues = OPACITY[parentId].active;
          const [activeFrom, activeTo] = newValues.split(';');
          animation.dataset.origValues = `${activeTo};${activeFrom}`;
        } else {
          const stateValues = {
            open: `${fromValue};${toValue}`,
            close: `${toValue};${fromValue}`,
            auto: isCollapsed ? `${toValue};${fromValue}` : `${fromValue};${toValue}`,
          };
          newValues = stateValues[state] || stateValues.auto;
        }

        if (animation.getAttribute('values') !== newValues) {
          animation.setAttribute('values', newValues);
          animation.beginElement();
        }
      });

      return [];
    }

    setFolderIndentation(tabs, groupElem = undefined, forCollapse = true, animate = true) {
      if (!gZenPinnedTabManager.expandedSidebarMode) {
        return;
      }
      let tab = tabs[0];
      let isTab = false;
      if (tab.group?.hasAttribute('split-view-group')) {
        tab = tab.group;
        isTab = true;
      }
      if (!groupElem && tab?.group) {
        groupElem = tab; // So we can set isTab later
      }
      if (
        gBrowser.isTab(groupElem) &&
        (!(groupElem.hasAttribute('zen-empty-tab') && groupElem.group === tab.group) ||
          groupElem?.hasAttribute('zen-empty-tab'))
      ) {
        groupElem = groupElem.group;
        isTab = true;
      }
      if (!isTab && !groupElem?.hasAttribute('selected') && !forCollapse) {
        groupElem = null; // Don't indent if the group is not selected
      }
      let level = groupElem?.level + 1 || 0;
      if (gBrowser.isTabGroupLabel(groupElem)) {
        // If it is a group label, we should not increase its level by one.
        level = groupElem.group.level;
      }
      const baseSpacing = 14; // Base spacing for each level
      let tabToAnimate = tab;
      if (gBrowser.isTabGroupLabel(tab)) {
        tabToAnimate = tab.group;
      }
      const tabLevel = tabToAnimate?.group?.level || 0;
      const spacing = (level - tabLevel) * baseSpacing;
      if (!animate) {
        for (const tab of tabs) {
          tab.style.setProperty('transition', 'none', 'important');
        }
      }
      for (const tab of tabs) {
        if (gBrowser.isTabGroupLabel(tab) || tab.group?.hasAttribute('split-view-group')) {
          tab.group.style.setProperty('--zen-folder-indent', `${spacing}px`);
          continue;
        }
        tab.style.setProperty('--zen-folder-indent', `${spacing}px`);
      }
      if (!animate) {
        for (const tab of tabs) {
          tab.style.removeProperty('transition');
        }
      }
    }

    changeFolderUserIcon(group) {
      if (!group) return;

      gZenEmojiPicker
        .open(group.icon, { onlySvgIcons: true })
        .then((icon) => {
          this.setFolderUserIcon(group, icon);
          group.dispatchEvent(new CustomEvent('ZenFolderIconChanged', { bubbles: true }));
        })
        .catch((err) => {
          console.error(err);
          return;
        });
    }

    setFolderUserIcon(group, icon) {
      const svgIcon = group.icon.querySelector('svg #folder-icon image');
      if (!svgIcon) return;
      svgIcon.setAttribute('href', icon ?? '');
      if (svgIcon.getAttribute('href') !== icon) {
        svgIcon.style.opacity = '0';
      } else {
        svgIcon.style.opacity = '1';
      }
    }

    #groupInit(group, stateData) {
      // Setup zen-folder icon to the correct position
      this.updateFolderIcon(group, 'auto', false);
      if (stateData?.userIcon) {
        this.setFolderUserIcon(group, stateData.userIcon);
      }

      if (group.collapsed) {
        this.on_TabGroupCollapse({ target: group });
      }

      const labelContainer = group.querySelector('.tab-group-label-container');
      // Setup mouseenter/mouseleave events for the folder
      labelContainer.addEventListener('mouseenter', (event) => {
        if (!group.collapsed || !Services.prefs.getBoolPref('zen.folders.search.enabled')) {
          return;
        }
        this.#mouseTimer = setTimeout(() => {
          this.openTabsPopup(event);
        }, Services.prefs.getIntPref('zen.folders.search.hover-delay'));
      });
      labelContainer.addEventListener('mouseleave', () => {
        clearTimeout(this.#mouseTimer);
        if (!group.collapsed) return;
        this.#mouseTimer = setTimeout(() => {
          // If popup is focused don't hide it
          if (this.#popup.matches(':hover')) return;
          this.#popup.hidePopup();
        }, 200);
      });
    }

    storeDataForSessionStore() {
      const folders = Array.from(gBrowser.tabContainer.querySelectorAll('zen-folder'));
      const splitGroups = Array.from(
        gBrowser.tabContainer.querySelectorAll('tab-group[split-view-group]')
      );
      const allData = [...folders, ...splitGroups];

      // Sort elements in the order in which they appear in the DOM
      allData.sort((a, b) => {
        const position = a.compareDocumentPosition(b);
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });

      const storedData = [];

      for (const folder of allData) {
        const parentFolder = folder.parentElement.closest('zen-folder');
        // Skip split-view-group if it's not a zen-folder child
        if (!parentFolder && folder.hasAttribute('split-view-group')) continue;
        const emptyFolderTabs = folder.tabs
          .filter((tab) => tab.hasAttribute('zen-empty-tab'))
          .map((tab) => tab.getAttribute('zen-pin-id'));

        let prevSiblingInfo = null;
        const prevSibling = folder.previousElementSibling;
        const userIcon = folder?.icon?.querySelector('svg #folder-icon image');

        if (prevSibling) {
          if (gBrowser.isTabGroup(prevSibling)) {
            prevSiblingInfo = { type: 'group', id: prevSibling.id };
          } else if (gBrowser.isTab(prevSibling) && prevSibling.hasAttribute('zen-pin-id')) {
            const zenPinId = prevSibling.getAttribute('zen-pin-id');
            prevSiblingInfo = { type: 'tab', id: zenPinId };
          } else {
            prevSiblingInfo = { type: 'start', id: null };
          }
        }

        storedData.push({
          pinned: folder.pinned,
          essential: folder.essential,
          splitViewGroup: folder.hasAttribute('split-view-group'),
          id: folder.id,
          name: folder.label,
          collapsed: folder.collapsed,
          saveOnWindowClose: folder.saveOnWindowClose,
          parentId: parentFolder ? parentFolder.id : null,
          prevSiblingInfo: prevSiblingInfo,
          emptyTabIds: emptyFolderTabs,
          userIcon: userIcon?.getAttribute('href'),
          pinId: folder.getAttribute('zen-pin-id'),
          // note: We shouldn't be using the workspace-id anywhere, we are just
          //  remembering it for the pinned tabs manager to use it later.
          workspaceId: folder.getAttribute('zen-workspace-id'),
        });
      }
      return storedData;
    }

    restoreDataFromSessionStore(data) {
      if (!data || this._sessionRestoring) {
        return;
      }

      this._sessionRestoring = true;

      const tabFolderWorkingData = new Map();

      for (const folderData of data) {
        const workingData = {
          stateData: folderData,
          node: null,
          containingTabsFragment: document.createDocumentFragment(),
        };
        tabFolderWorkingData.set(folderData.id, workingData);

        const oldGroup = document.getElementById(folderData.id);
        folderData.emptyTabIds.forEach((zenPinId) => {
          oldGroup
            ?.querySelector(`tab[zen-pin-id="${zenPinId}"]`)
            ?.setAttribute('zen-empty-tab', true);
        });
        if (oldGroup) {
          if (!folderData.splitViewGroup) {
            const folder = this._createFolderNode({
              id: folderData.id,
              label: folderData.name,
              collapsed: folderData.collapsed,
              pinned: folderData.pinned,
              saveOnWindowClose: folderData.saveOnWindowClose,
              workspaceId: folderData.workspaceId,
            });
            folder.setAttribute('zen-pin-id', folderData.pinId);
            workingData.node = folder;
            oldGroup.before(folder);
          } else {
            workingData.node = oldGroup;
          }
          while (oldGroup.tabs.length > 0) {
            const tab = oldGroup.tabs[0];
            if (folderData.workspaceId) {
              tab.setAttribute('zen-workspace-id', folderData.workspaceId);
            }
            workingData.containingTabsFragment.appendChild(tab);
          }
          if (!folderData.splitViewGroup) {
            oldGroup.remove();
          }
        }
      }

      for (const { node, containingTabsFragment } of tabFolderWorkingData.values()) {
        if (node) {
          node.appendChild(containingTabsFragment);
        }
      }

      // Nesting folders into each other according to parentId.
      for (const { stateData, node } of tabFolderWorkingData.values()) {
        if (node && stateData.parentId) {
          const parentWorkingData = tabFolderWorkingData.get(stateData.parentId);
          if (parentWorkingData && parentWorkingData.node) {
            switch (stateData?.prevSiblingInfo?.type) {
              case 'group': {
                const folder = document.getElementById(stateData.prevSiblingInfo.id);
                folder.after(node);
                break;
              }
              case 'tab': {
                const tab = parentWorkingData.node.querySelector(
                  `[zen-pin-id="${stateData.prevSiblingInfo.id}"]`
                );
                tab.after(node);
                break;
              }
              default: {
                // Should insert after zen-empty-tab
                const start =
                  parentWorkingData.node.querySelector('.zen-tab-group-start').nextElementSibling;
                start.after(node);
              }
            }
          }
        }
      }

      // Initialize UI state for all folders.
      for (const { stateData, node } of tabFolderWorkingData.values()) {
        if (node && !stateData.splitViewGroup) {
          this.#groupInit(node, stateData);
        }
      }

      gBrowser.tabContainer._invalidateCachedTabs();
      this._sessionRestoring = false;
    }

    /**
     * Highlights the given tab group and removes highlight from any previously highlighted group.
     * @param {MozTabbrowserTabGroup|undefined|null} folder The folder to highlight, or null to clear highlight.
     * @param {Array<MozTabbrowserTab>|null} movingTabs The tabs being moved.
     */
    highlightGroupOnDragOver(folder, movingTabs) {
      if (folder === this.#lastHighlightedGroup) return;
      const tab = movingTabs ? movingTabs[0] : null;
      if (this.#lastHighlightedGroup && this.#lastHighlightedGroup !== folder) {
        this.#lastHighlightedGroup.removeAttribute('selected');
        if (this.#lastHighlightedGroup.collapsed) {
          this.updateFolderIcon(this.#lastHighlightedGroup, 'close');
        }
        this.#lastHighlightedGroup = null;
      }

      if (
        folder &&
        (!folder.hasAttribute('split-view-group') || !folder.hasAttribute('selected')) &&
        folder !== tab?.group &&
        !(
          folder.level >= ZEN_MAX_SUBFOLDERS && movingTabs?.some((t) => gBrowser.isTabGroupLabel(t))
        )
      ) {
        folder.setAttribute('selected', 'true');
        folder.style.transform = '';
        if (folder.collapsed) {
          this.updateFolderIcon(folder, 'open');
        }
        this.#lastHighlightedGroup = folder;
      }
    }

    /**
     * Ungroup a tab from all the active groups it belongs to.
     * @param {MozTabbrowserTab[]} tabs The tab to ungroup.
     */
    ungroupTabsFromActiveGroups(tabs) {
      for (const tab of tabs) {
        gBrowser.ungroupTabsUntilNoActive(tab);
      }
    }

    /**
     * Handles the dragover logic when dragging a tab or tab group label over another tab group label.
     * This function determines where the dragged item should be visually dropped (before/after the group, or inside it)
     * and updates related styling and highlighting.
     *
     * @param {MozTabbrowserTabGroupLabel} currentDropElement The tab group label currently being dragged over.
     * @param {MozTabbrowserTab|MozTabbrowserTabGroupLabel} draggedTab The tab or tab group label being dragged.
     * @param {number} overlapPercent The percentage of overlap between the dragged item and the drop target.
     * @param {Array<MozTabbrowserTab>} movingTabs An array of tabs that are currently being dragged together.
     * @param {boolean} currentDropBefore Indicates if the current drop position is before the middle of the drop element.
     * @param {string|undefined} currentColorCode The current color code for dragover highlighting.
     * @returns {{dropElement: MozTabbrowserTabGroup|MozTabbrowserTab|MozTabbrowserTabGroupLabel, colorCode: string|undefined, dropBefore: boolean}}
     *   An object containing the updated drop element, color code for highlighting, and drop position.
     */
    handleDragOverTabGroupLabel(
      currentDropElement,
      draggedTab,
      overlapPercent,
      movingTabs,
      currentDropBefore,
      currentColorCode
    ) {
      let dropElement = currentDropElement;
      let dropBefore = currentDropBefore;
      let colorCode = currentColorCode;
      let dragUpThreshold =
        Services.prefs.getIntPref('zen.view.drag-and-drop.drop-inside-upper-threshold') / 100;
      let dragDownThreshold =
        Services.prefs.getIntPref('zen.view.drag-and-drop.drop-inside-lower-threshold') / 100;

      const dropElementGroup = dropElement.group;
      const isSplitGroup = dropElement?.group?.hasAttribute('split-view-group');
      let firstGroupElem =
        dropElementGroup.querySelector('.zen-tab-group-start').nextElementSibling;
      if (gBrowser.isTabGroup(firstGroupElem)) firstGroupElem = firstGroupElem.labelElement;

      const isRestrictedGroup = isSplitGroup || dropElementGroup.collapsed;

      const shouldDropInside =
        !dropBefore &&
        overlapPercent >= dragDownThreshold &&
        overlapPercent <= dragUpThreshold &&
        !isSplitGroup;
      const shouldDropNear = overlapPercent < dragUpThreshold || overlapPercent > dragDownThreshold;

      if (shouldDropInside) {
        dropElement = firstGroupElem;
        dropBefore = true;
        this.highlightGroupOnDragOver(dropElementGroup, movingTabs);
      } else if (shouldDropNear) {
        if (dropBefore) {
          colorCode = undefined;
        } else if (!isRestrictedGroup) {
          dropElement = firstGroupElem;
          dropBefore = true;
        }
        this.highlightGroupOnDragOver(null);
      }

      return { dropElement, colorCode, dropBefore };
    }

    #normalizeGroupItems(items) {
      return items
        .filter((item) => !item.hasAttribute('zen-empty-tab'))
        .map((item) => {
          if (gBrowser.isTabGroup(item)) {
            item = item.firstChild;
          } else if (gBrowser.isTabGroupLabel(item)) {
            if (item?.group?.hasAttribute('split-view-group')) {
              item = item.group;
            } else {
              item = item.parentElement;
            }
          }
          return item;
        });
    }

    #collectGroupItems(group, opts = {}) {
      const { selectedTabs = [], splitViewIds = new Set(), activeFoldersIds = new Set() } = opts;
      const folders = new Map();
      return group.childGroupsAndTabs
        .filter((item) => !item.hasAttribute('zen-empty-tab'))
        .map((item) => {
          const isSplitView = item.group?.hasAttribute?.('split-view-group');
          const group = isSplitView ? item.group.group : item.group;
          if (!folders.has(group?.id)) {
            folders.set(group?.id, group?.activeGroups[0]);
          }
          const lastActiveFolder = folders.get(group?.id);
          const activeFolderId = lastActiveFolder?.id;
          const splitViewId = isSplitView ? item?.group?.id : null;

          if (item.multiselected || item.selected || item.hasAttribute('folder-active')) {
            selectedTabs.push(item);
            if (splitViewId) splitViewIds.add(splitViewId);
            if (activeFolderId) activeFoldersIds.add(activeFolderId);
          }

          if (gBrowser.isTabGroupLabel(item)) {
            if (isSplitView) {
              item = item.group;
            } else {
              item = item.parentElement;
            }
          }

          return { item, splitViewId, activeFolderId };
        });
    }

    #createAnimation(items, targetState, opts, callback = () => {}) {
      items = Array.isArray(items) ? items : [items];
      return items.map((item) =>
        gZenUIManager.motion.animate(item, targetState, opts).then(callback)
      );
    }

    #calculateHeightShift(tabsContainer, selectedTabs) {
      let heightShift = 0;
      if (selectedTabs.length) {
        return heightShift;
      } else {
        heightShift += window.windowUtils.getBoundsWithoutFlushing(tabsContainer).height;
      }
      return heightShift;
    }

    async animateCollapse(group) {
      const animations = [];
      const selectedTabs = [];
      const splitViewIds = new Set();
      const activeFoldersIds = new Set();
      const itemsToHide = [];

      const tabsContainer = group.querySelector('.tab-group-container');
      const groupStart = group.querySelector('.zen-tab-group-start');

      const groupItems = this.#collectGroupItems(group, {
        selectedTabs,
        splitViewIds,
        activeFoldersIds,
      });
      const heightUntilSelected = this.#calculateHeightShift(tabsContainer, selectedTabs);

      if (selectedTabs.length) {
        for (let i = 0; i < groupItems.length; i++) {
          const { item, splitViewId, activeFolderId } = groupItems[i];

          // Skip selected items
          if (selectedTabs.includes(item)) continue;

          // Skip items from selected split-view groups
          if (splitViewId && splitViewIds.has(splitViewId)) continue;

          // Skip items from selected active groups
          if (activeFolderId && activeFoldersIds.has(activeFolderId)) {
            // If item is tab-group-label-container we should hide it.
            // Other items between tab-group-labe-container and folder-active tab should be visible cuz they are hidden by margin-top
            if (item.parentElement.id !== activeFolderId && !item.hasAttribute('folder-active')) {
              continue;
            }
          }

          if (!itemsToHide.includes(item)) {
            itemsToHide.push(item);
          }
        }

        group.setAttribute('has-active', 'true');
        group.activeTabs = selectedTabs;

        selectedTabs.forEach((tab) => {
          this.setFolderIndentation([tab], group, /* for collapse = */ true);
        });
      }

      animations.push(
        ...this.#createAnimation(
          itemsToHide,
          { opacity: 0, height: 0 },
          { duration: 0.12, ease: 'easeInOut' }
        ),
        ...this.updateFolderIcon(group),
        ...this.#createAnimation(
          groupStart,
          {
            marginTop: -(heightUntilSelected + 4 * (selectedTabs.length === 0 ? 1 : 0)),
          },
          { duration: 0.12, ease: 'easeInOut' }
        )
      );

      gBrowser.tabContainer._invalidateCachedVisibleTabs();
      this.#animationCount += 1;
      await Promise.all(animations);
      if (this.#animationCount) {
        return;
      }
      // Prevent hiding if we spam the group animations
      this.#animationCount -= 1;
      if (!selectedTabs.length && !this.#animationCount) {
        tabsContainer.setAttribute('hidden', true);
      }

      this.styleCleanup(itemsToHide);
    }

    async animateExpand(group) {
      const animations = [];
      const itemsToHide = [];

      const tabsContainer = group.querySelector('.tab-group-container');
      tabsContainer.removeAttribute('hidden');
      tabsContainer.style.overflow = 'hidden';

      const groupStart = group.querySelector('.zen-tab-group-start');
      const itemsToShow = this.#normalizeGroupItems(group.childGroupsAndTabs);
      const activeFolders = Array.from(group.querySelectorAll('zen-folder[has-active]'));

      for (const folder of activeFolders) {
        const splitViewIds = new Set();
        const selectedTabs = folder.activeTabs;

        const activeFoldersIds = new Set();
        const activeFolderItems = this.#collectGroupItems(folder, {
          splitViewIds,
          activeFoldersIds,
        });

        if (selectedTabs.length) {
          for (let i = 0; i < activeFolderItems.length; i++) {
            const { item, splitViewId, activeFolderId } = activeFolderItems[i];

            // Skip selected items
            if (selectedTabs.includes(item)) continue;

            // Skip items from selected split-view groups
            if (splitViewId && splitViewIds.has(splitViewId)) continue;

            if (activeFolderId && activeFoldersIds.has(activeFolderId)) {
              const folder = item.parentElement;
              if (
                gBrowser.isTabGroup(folder) &&
                folder.id !== activeFolderId &&
                item.hasAttribute('folder-active')
              ) {
                continue;
              }
            }

            if (!itemsToHide.includes(item)) {
              itemsToHide.push(item);
            }
          }
        }
      }

      const afterMarginTop = () => {
        tabsContainer.style.overflow = '';
        if (group.hasAttribute('has-active')) {
          const activeTabs = group.activeTabs;
          const folders = new Map();
          group.removeAttribute('has-active');
          for (let tab of activeTabs) {
            const group = tab?.group?.hasAttribute('split-view-group')
              ? tab?.group?.group
              : tab?.group;
            if (!folders.has(group?.id)) {
              folders.set(group?.id, group?.activeGroups?.at(-1));
            }
            let activeGroup = folders.get(group?.id);
            if (activeGroup) {
              this.setFolderIndentation([tab], activeGroup, /* for collapse = */ true);
            } else {
              // Since the folder is now expanded, we should remove active attribute
              // to the tab that was previously visible
              tab.removeAttribute('folder-active');
              if (tab.group?.hasAttribute('split-view-group')) {
                tab.group.style.removeProperty('--zen-folder-indent');
              } else {
                tab.style.removeProperty('--zen-folder-indent');
              }
            }
          }
          folders.clear();
        }
        // Folder has been expanded and has no active tabs
        group.activeTabs = [];
      };

      animations.push(
        ...this.#createAnimation(
          itemsToShow,
          { opacity: '', height: '' },
          { duration: 0.12, ease: 'easeInOut' }
        ),
        ...this.#createAnimation(
          itemsToHide,
          { opacity: 0, height: 0 },
          { duration: 0.12, ease: 'easeInOut' }
        ),
        ...this.updateFolderIcon(group),
        ...this.#createAnimation(
          groupStart,
          {
            marginTop: 0,
          },
          { duration: 0.12, ease: 'easeInOut' },
          afterMarginTop
        )
      );

      this.#animationCount += 1;
      await Promise.all(animations);
      this.#animationCount -= 1;

      // Cleanup
      this.styleCleanup(itemsToShow);
      this.styleCleanup(itemsToHide);
    }

    async animateUnload(group, tabToUnload, ungroup = false) {
      const isSplitView = tabToUnload.group?.hasAttribute('split-view-group');
      if ((!group?.isZenFolder || !isSplitView) && !tabToUnload.hasAttribute('folder-active'))
        return;
      const animations = [];

      const activeGroups = group.activeGroups;
      for (const folder of activeGroups) {
        folder.activeTabs = folder.activeTabs.filter((tab) => tab !== tabToUnload);

        if (folder.activeTabs.length === 0) {
          folder.removeAttribute('has-active');
          const groupItems = this.#normalizeGroupItems(folder.allItems);
          const tabsContainer = folder.querySelector('.tab-group-container');

          this.styleCleanup(groupItems);

          const groupStart = folder.querySelector('.zen-tab-group-start');

          tabsContainer.offsetHeight;
          tabsContainer.setAttribute('hidden', true);

          const heightUntilSelected = this.#calculateHeightShift(tabsContainer, []);

          animations.push(
            ...this.updateFolderIcon(folder, 'close', false),
            ...this.#createAnimation(
              groupStart,
              {
                marginTop: -(heightUntilSelected + 4),
              },
              { duration: 0.12, ease: 'easeInOut' }
            )
          );
        }
      }

      tabToUnload.removeAttribute('folder-active');
      if (isSplitView) {
        tabToUnload = tabToUnload.group;
      }

      tabToUnload.style.removeProperty('--zen-folder-indent');

      if (!ungroup) {
        animations.push(
          ...this.#createAnimation(
            tabToUnload,
            {
              opacity: 0,
              height: 0,
            },
            {
              duration: 0.12,
              ease: 'easeInOut',
            }
          )
        );
      }

      this.#animationCount += 1;
      await Promise.all(animations);
      this.#animationCount -= 1;
      gBrowser.tabContainer._invalidateCachedTabs();
    }

    async animateSelect(group) {
      if (!group?.isZenFolder) return;

      this.cancelPopupTimer();

      const animations = [];
      const selectedTabs = [];
      const splitViewIds = new Set();
      const itemsToHide = [];

      const groupItems = this.#collectGroupItems(group, {
        selectedTabs,
        splitViewIds,
      });

      for (const tab of selectedTabs) {
        let currentGroup = tab?.group?.hasAttribute('split-view-group')
          ? tab.group.group
          : tab?.group;
        while (currentGroup) {
          const activeTabs = selectedTabs.filter((t) => currentGroup.tabs.includes(t));
          if (activeTabs.length) {
            if (currentGroup.collapsed) {
              if (currentGroup.hasAttribute('has-active')) {
                // It is important to keep the sequence of elements as in the DOM
                currentGroup.activeTabs = [
                  ...new Set([...currentGroup.activeTabs, ...activeTabs]),
                ].sort((a, b) => a._tPos > b._tPos);
              } else {
                currentGroup.setAttribute('has-active', 'true');
                currentGroup.activeTabs = activeTabs;
              }

              const tabsContainer = currentGroup.querySelector('.tab-group-container');
              const groupStart = currentGroup.querySelector('.zen-tab-group-start');

              if (tabsContainer.hasAttribute('hidden')) tabsContainer.removeAttribute('hidden');

              const afterMarginTop = () => {
                tabsContainer.style.overflow = '';
              };

              animations.push(
                ...this.updateFolderIcon(currentGroup, 'close', false),
                ...this.#createAnimation(
                  groupStart,
                  {
                    marginTop: 0,
                  },
                  { duration: 0.12, ease: 'easeInOut' },
                  afterMarginTop
                )
              );
              for (const tab of activeTabs) {
                this.setFolderIndentation(
                  [tab],
                  currentGroup,
                  /* for collapse = */ true,
                  /* animate = */ false
                );
              }
            }
          }
          currentGroup = currentGroup.group;
        }
      }

      if (selectedTabs.length) {
        for (let i = 0; i < groupItems.length; i++) {
          const { item, splitViewId } = groupItems[i];

          // Skip selected items
          if (selectedTabs.includes(item)) continue;

          // Skip items from selected split-view groups
          if (splitViewId && splitViewIds.has(splitViewId)) continue;

          if (!item.hasAttribute?.('folder-active')) {
            if (!itemsToHide.includes(item)) itemsToHide.push(item);
          }
        }
      }

      // FIXME: This is a hack to fix the animations not working properly
      itemsToHide.forEach((item) => {
        item.style.opacity = 0;
        item.style.height = 0;
      });
      this.styleCleanup(selectedTabs);

      animations.push(
        ...this.#createAnimation(
          itemsToHide,
          {
            opacity: 0,
            height: 0,
          },
          {
            duration: 0.12,
            ease: 'easeInOut',
          }
        ),
        ...this.#createAnimation(
          selectedTabs,
          {
            opacity: '',
            height: '',
          },
          {
            duration: 0.12,
            ease: 'easeInOut',
          }
        )
      );

      this.#animationCount += 1;
      await Promise.all(animations);
      this.#animationCount -= 1;
      if (this.#animationCount) {
        return;
      }

      // Cleanup
      this.styleCleanup(itemsToHide);
      this.styleCleanup(selectedTabs);
    }

    animateGroupMove(group, expand = false) {
      if (!group?.isZenFolder) return;
      const groupStart = group.querySelector('.zen-tab-group-start');
      const tabsContainer = group.querySelector('.tab-group-container');
      const heightContainer = expand ? 0 : this.#calculateHeightShift(tabsContainer, []);
      tabsContainer.style.overflow = expand ? '' : 'clip';

      this.#createAnimation(
        groupStart,
        {
          marginTop: expand ? 0 : -(heightContainer + 4),
        },
        { duration: 0.12, ease: 'easeInOut' }
      );
    }

    styleCleanup(items) {
      items.forEach((item) => {
        item.style.removeProperty('opacity');
        item.style.removeProperty('height');
      });
    }
  }

  window.gZenFolders = new nsZenFolders();
}
