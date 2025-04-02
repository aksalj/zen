document.addEventListener(
  'MozBeforeInitialXULLayout',
  () => {
    // <commandset id="mainCommandSet"> defined in browser-sets.inc
    document
      .getElementById('zenCommandSet')
      // eslint-disable-next-line complexity
      .addEventListener('command', (event) => {
        switch (event.target.id) {
          case 'cmd_zenCompactModeToggle':
            gZenCompactModeManager.toggle();
            break;
          case 'cmd_zenCompactModeShowSidebar':
            gZenCompactModeManager.toggleSidebar();
            break;
          case 'cmd_zenCompactModeShowToolbar':
            gZenCompactModeManager.toggleToolbar();
            break;
          case 'cmd_zenWorkspaceForward':
            ZenWorkspaces.changeWorkspaceShortcut();
            break;
          case 'cmd_zenWorkspaceBackward':
            ZenWorkspaces.changeWorkspaceShortcut(-1);
            break;
          case 'cmd_zenSplitViewGrid':
            gZenViewSplitter.toggleShortcut('grid');
            break;
          case 'cmd_zenSplitViewVertical':
            gZenViewSplitter.toggleShortcut('vsep');
            break;
          case 'cmd_zenSplitViewHorizontal':
            gZenViewSplitter.toggleShortcut('hsep');
            break;
          case 'cmd_zenSplitViewUnsplit':
            gZenViewSplitter.toggleShortcut('unsplit');
            break;
          case 'cmd_zenCopyCurrentURLMarkdown':
            gZenCommonActions.copyCurrentURLAsMarkdownToClipboard();
            break;
          case 'cmd_zenCopyCurrentURL':
            gZenCommonActions.copyCurrentURLToClipboard();
            break;
          case 'cmd_zenPinnedTabReset':
            gZenPinnedTabManager.resetPinnedTab(gBrowser.selectedTab);
            break;
          case 'cmd_zenPinnedTabResetNoTab':
            gZenPinnedTabManager.resetPinnedTab();
            break;
          case 'cmd_zenToggleSidebar':
            gZenVerticalTabsManager.toggleExpand();
            break;
          case 'cmd_zenOpenZenThemePicker':
            gZenThemePicker.openThemePicker(event);
            break;
          case 'cmd_zenChangeWorkspaceTab':
            ZenWorkspaces.changeTabWorkspace(event.target.getAttribute('zen-workspace-id'));
            break;
          case 'cmd_zenToggleTabsOnRight':
            gZenVerticalTabsManager.toggleTabsOnRight();
            break;
          case 'cmd_zenSplitViewLinkInNewTab':
            gZenViewSplitter.splitLinkInNewTab();
            break;
          case 'cmd_zenReplacePinnedUrlWithCurrent':
            gZenPinnedTabManager.replacePinnedUrlWithCurrent();
            break;
          case 'cmd_zenAddToEssentials':
            gZenPinnedTabManager.addToEssentials();
            break;
          case 'cmd_zenRemoveFromEssentials':
            gZenPinnedTabManager.removeEssentials();
            break;
          case 'cmd_zenUnloadTab':
            gZenTabUnloader.unloadTab();
            break;
          case 'cmd_zenPreventUnloadTab':
            gZenTabUnloader.preventUnloadTab();
            break;
          case 'cmd_zenIgnoreUnloadTab':
            gZenTabUnloader.ignoreUnloadTab();
            break;
          default:
            if (event.target.id.startsWith('cmd_zenWorkspaceSwitch')) {
              const index = parseInt(event.target.id.replace('cmd_zenWorkspaceSwitch', ''), 10) - 1;
              ZenWorkspaces.shortcutSwitchTo(index);
            }
            break;
        }
      });
  },
  { once: true }
);
