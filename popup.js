/**
 * Slack Export Extension Batch Export Popup
 * Orchestrates multi-channel export via the content script running on the Slack page.
 */

// ── State ──────────────────────────────────────────────────────────

let channels = [];
let config = {};
let lastExportTimestamps = {};
let activeTab = null;
let isExporting = false;
let activeExportChannelId = null;
let liveStats = { messages: 0, attachments: 0 };
let completedStats = { messages: 0, attachments: 0 };
let channelLiveStats = { messages: 0, attachments: 0 };

// ── DOM references ─────────────────────────────────────────────────

const channelListEl = document.getElementById('channelList');
const noChannelsEl = document.getElementById('noChannels');
const notOnSlackEl = document.getElementById('notOnSlack');
const exportBtn = document.getElementById('exportBtn');
const combinedExportCb = document.getElementById('combinedExport');
const progressSection = document.getElementById('progressSection');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const activityText = document.getElementById('activityText');
const progressMessages = document.getElementById('progressMessages');
const progressAttachments = document.getElementById('progressAttachments');
const progressSpinner = document.getElementById('progressSpinner');
const summarySection = document.getElementById('summarySection');
const exportControls = document.getElementById('exportControls');
const settingsBtn = document.getElementById('settingsBtn');
const quickAddBtn = document.getElementById('quickAddBtn');
const cleanupChannelsBtn = document.getElementById('cleanupChannelsBtn');
const quickAddSection = document.getElementById('quickAddSection');
const openOptionsLink = document.getElementById('openOptionsLink');

// ── Initialisation ─────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tab;

    // Check if we're on a Slack page
    if (!tab.url || !tab.url.includes('slack.com')) {
      notOnSlackEl.style.display = 'block';
      channelListEl.style.display = 'none';
      exportControls.style.display = 'none';
      quickAddSection.style.display = 'none';
      return;
    }

    // Load config
    config = await getConfig();
    lastExportTimestamps = config.lastExportTimestamps || {};
    channels = config.channels || [];

    // If no channels configured, seed from local config file or example defaults
    if (channels.length === 0) {
      channels = await loadLocalChannels() || INITIAL_CHANNELS;
      await saveConfig({ channels });
    }

    // Load combined export preference
    combinedExportCb.checked = config.combinedExport || false;

    renderChannels();
    await restoreExportUiState();
    updateExportButton();
  } catch (error) {
    console.error('Popup init error:', error);
  }
});

// ── Event listeners ────────────────────────────────────────────────

settingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

openOptionsLink && openOptionsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

exportBtn.addEventListener('click', () => {
  if (!isExporting) exportSelected();
});

combinedExportCb.addEventListener('change', async () => {
  await saveConfig({ combinedExport: combinedExportCb.checked });
});

quickAddBtn.addEventListener('click', quickAddCurrentChannel);
cleanupChannelsBtn.addEventListener('click', cleanupInvalidChannels);

chrome.runtime.onMessage.addListener((message) => {
  if (!isExporting || !message || message.action !== 'BATCH_EXPORT_PROGRESS') return;
  if (activeExportChannelId && message.channelId && message.channelId !== activeExportChannelId) return;
  handleLiveProgressUpdate(message);
});

// ── Render ─────────────────────────────────────────────────────────

function renderChannels() {
  channelListEl.innerHTML = '';

  const enabledChannels = channels.filter(c => c.enabled);
  if (enabledChannels.length === 0 && channels.length === 0) {
    noChannelsEl.style.display = 'block';
    channelListEl.style.display = 'none';
    exportControls.style.display = 'none';
    return;
  }

  noChannelsEl.style.display = 'none';
  channelListEl.style.display = 'block';
  exportControls.style.display = 'block';

  // Group by tier
  const tiers = {};
  for (const ch of channels) {
    const tier = ch.tier || 1;
    if (!tiers[tier]) tiers[tier] = [];
    tiers[tier].push(ch);
  }

  const sortedTiers = Object.keys(tiers).sort((a, b) => Number(a) - Number(b));

  for (const tier of sortedTiers) {
    const tierChannels = tiers[tier];
    const group = document.createElement('div');
    group.className = 'tier-group';

    // Tier header with select-all checkbox
    const header = document.createElement('div');
    header.className = 'tier-header';

    const tierCb = document.createElement('input');
    tierCb.type = 'checkbox';
    tierCb.id = `tier-${tier}`;
    tierCb.dataset.tier = tier;

    const tierLabel = document.createElement('label');
    tierLabel.htmlFor = `tier-${tier}`;
    tierLabel.textContent = `Tier ${tier} (${tierChannels.length})`;

    header.appendChild(tierCb);
    header.appendChild(tierLabel);
    group.appendChild(header);

    // Channel items
    for (const ch of tierChannels) {
      const hasValidId = isSlackConversationId(ch.channelId);
      const item = document.createElement('div');
      item.className = 'channel-item';
      item.dataset.channelId = ch.channelId;
      if (!ch.enabled) item.classList.add('disabled');
      if (!ch.channelId || !hasValidId) item.classList.add('no-id');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'channel-cb';
      cb.dataset.channelId = ch.channelId;
      cb.dataset.tier = ch.tier;
      cb.disabled = !ch.enabled || !ch.channelId || !hasValidId;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'channel-name';
      const typeIcon = ch.type === 'dm' ? '💬 ' : ch.type === 'group' ? '👥 ' : '# ';
      nameSpan.innerHTML = `<span class="type-icon">${typeIcon}</span>${escapeHtml(ch.name)}`;

      const metaSpan = document.createElement('span');
      metaSpan.className = 'channel-meta';
      if (!ch.channelId) {
        metaSpan.textContent = 'no ID';
        metaSpan.style.color = '#e01e5a';
      } else if (!hasValidId) {
        metaSpan.textContent = 'invalid ID';
        metaSpan.style.color = '#e01e5a';
      } else {
        metaSpan.textContent = formatLastExported(ch.channelId);
      }

      const statusSpan = document.createElement('span');
      statusSpan.className = 'channel-status';
      statusSpan.id = `status-${ch.channelId}`;

      item.appendChild(cb);
      item.appendChild(nameSpan);
      item.appendChild(metaSpan);
      item.appendChild(statusSpan);
      group.appendChild(item);

      cb.addEventListener('change', () => {
        updateTierCheckbox(ch.tier);
        updateExportButton();
      });
    }

    // Tier checkbox behaviour
    tierCb.addEventListener('change', () => {
      const cbs = group.querySelectorAll('.channel-cb:not(:disabled)');
      cbs.forEach(cb => { cb.checked = tierCb.checked; });
      updateExportButton();
    });

    channelListEl.appendChild(group);
  }
}

// ── Selection helpers ──────────────────────────────────────────────

function getSelectedChannels() {
  const selected = [];
  const cbs = channelListEl.querySelectorAll('.channel-cb:checked');
  cbs.forEach(cb => {
    const ch = channels.find(c => c.channelId === cb.dataset.channelId);
    if (ch) selected.push(ch);
  });
  return selected;
}

function updateExportButton() {
  const count = getSelectedChannels().length;
  exportBtn.textContent = `Export Selected (${count} channel${count !== 1 ? 's' : ''})`;
  exportBtn.disabled = count === 0 || isExporting;
}

function updateTierCheckbox(tier) {
  const tierCb = document.getElementById(`tier-${tier}`);
  if (!tierCb) return;
  const tierCbs = channelListEl.querySelectorAll(`.channel-cb[data-tier="${tier}"]:not(:disabled)`);
  const checkedCbs = channelListEl.querySelectorAll(`.channel-cb[data-tier="${tier}"]:not(:disabled):checked`);
  tierCb.checked = tierCbs.length > 0 && checkedCbs.length === tierCbs.length;
  tierCb.indeterminate = checkedCbs.length > 0 && checkedCbs.length < tierCbs.length;
}

// ── Batch export orchestration ─────────────────────────────────────

async function exportSelected() {
  const selected = getSelectedChannels();
  if (selected.length === 0) return;

  isExporting = true;
  exportBtn.disabled = true;
  progressSection.style.display = 'block';
  summarySection.style.display = 'none';
  exportControls.style.display = 'none';
  await notifyExportSession('start', { totalChannels: selected.length });

  // Disable all checkboxes during export
  channelListEl.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.disabled = true; });

  const results = [];
  let combinedMarkdown = '';
  completedStats = { messages: 0, attachments: 0 };
  channelLiveStats = { messages: 0, attachments: 0 };
  if (progressSpinner) progressSpinner.style.animationPlayState = 'running';
  setLiveStats(0, 0);

  for (let i = 0; i < selected.length; i++) {
    const channel = selected[i];
    activeExportChannelId = channel.channelId;
    channelLiveStats = { messages: 0, attachments: 0 };
    setLiveStats(completedStats.messages, completedStats.attachments);
    updateProgress(i, selected.length, channel.name);
    setActivity(`Starting ${channel.name}...`);
    setChannelStatus(channel.channelId, 'active');
    await notifyExportSession('channel_start', {
      channelId: channel.channelId,
      channelName: channel.name
    });

    try {
      if (!isSlackConversationId(channel.channelId)) {
        setChannelStatus(channel.channelId, 'error');
        results.push({
          channel: channel.name,
          success: false,
          error: `Invalid conversation ID: ${channel.channelId}`
        });
        continue;
      }

      // Calculate oldestTimestamp based on historyDays from now
      // Always respect historyDays by going back from current time
      const historyDaysMs = (config.historyDays || 7) * 86400 * 1000;
      const oldestTimestamp = Date.now() - historyDaysMs;

      const response = await chrome.tabs.sendMessage(activeTab.id, {
        action: 'BATCH_EXPORT_CHANNEL',
        channelId: channel.channelId,
        channelName: channel.name,
        oldestTimestamp: oldestTimestamp
      });

      if (response && response.success) {
        const channelMessageCount = Number(response.messageCount || 0);
        const channelAttachmentCount = Number(response.attachmentCount || 0);
        setLiveStats(
          completedStats.messages + channelMessageCount,
          completedStats.attachments + channelAttachmentCount
        );

        // Always download markdown file, regardless of message count
        // Ensure markdown exists - generate fallback if missing
        let markdownToDownload = response.markdown;
        if (!markdownToDownload || !markdownToDownload.trim()) {
          console.warn(`⚠️ No markdown content for ${channel.name}, generating fallback...`);
          const now = new Date();
          const exportTime = now.toLocaleString();
          markdownToDownload = `# Slack Export Extension Export: ${channel.name}\n*Exported: ${exportTime}*\n\n---\n\n*Note: No messages found or export encountered errors*\n\n`;
        }

        console.log(`💾 Downloading markdown for ${channel.name} (${response.messageCount || 0} messages, ${markdownToDownload.length} chars)`);

        // If content script already saved markdown, avoid duplicate file.
        let channelSaved = false;
        if (response.markdownSavedByContent) {
          console.log(`✅ Markdown already saved by content script for ${channel.name}`);
          channelSaved = true;
        } else {
          // Trigger download via background script - always create file
          // Retry download if it fails
          let downloadSuccess = false;
          let downloadError = null;
          for (let retry = 0; retry < 3; retry++) {
            try {
              const downloadResponse = await chrome.runtime.sendMessage({
                action: 'DOWNLOAD_FILE',
                data: {
                  filename: generateFilename(channel.name),
                  content: markdownToDownload,
                  directory: config.downloadDirectory || 'slack-exports'
                }
              });

              if (downloadResponse && downloadResponse.success) {
                downloadSuccess = true;
                channelSaved = true;
                break;
              } else {
                downloadError = downloadResponse?.error || 'Download failed';
                if (retry < 2) {
                  console.warn(`⚠️ Download attempt ${retry + 1} failed, retrying...`);
                  await new Promise(resolve => setTimeout(resolve, 1000));
                }
              }
            } catch (downloadErr) {
              downloadError = downloadErr.message;
              if (retry < 2) {
                console.warn(`⚠️ Download attempt ${retry + 1} threw error, retrying...`);
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
            }
          }

          if (!downloadSuccess) {
            console.error(`❌ Download failed for ${channel.name} after 3 attempts:`, downloadError);
            setChannelStatus(channel.channelId, 'error');
            results.push({ channel: channel.name, success: false, error: downloadError || 'Download failed' });
            continue;
          }

          console.log(`✅ Successfully downloaded markdown for ${channel.name}`);
        }

        // Accumulate for combined file (only if there are messages)
        if (combinedExportCb.checked && response.messageCount > 0) {
          combinedMarkdown += `\n\n---\n\n## ${channel.name}\n\n` + response.markdown.split('\n').slice(3).join('\n');
        }

        // Update last exported timestamp for any successful channel export.
        // This reflects export completion even when save path differs.
        lastExportTimestamps[channel.channelId] = Date.now();
        await saveConfig({ lastExportTimestamps });
        refreshChannelLastExportMeta(channel.channelId);

        setChannelStatus(channel.channelId, 'success');
        await notifyExportSession('channel_done', {
          channelId: channel.channelId,
          channelName: channel.name,
          status: 'success'
        });
        completedStats.messages += channelMessageCount;
        completedStats.attachments += channelAttachmentCount;
        setLiveStats(completedStats.messages, completedStats.attachments);
        results.push({
          channel: channel.name,
          success: true,
          count: channelMessageCount,
          attachments: channelAttachmentCount
        });
      } else {
        setChannelStatus(channel.channelId, 'error');
        await notifyExportSession('channel_done', {
          channelId: channel.channelId,
          channelName: channel.name,
          status: 'error'
        });
        results.push({ channel: channel.name, success: false, error: response?.error || 'Unknown error' });
      }
    } catch (error) {
      setChannelStatus(channel.channelId, 'error');
      await notifyExportSession('channel_done', {
        channelId: channel.channelId,
        channelName: channel.name,
        status: 'error'
      });
      results.push({ channel: channel.name, success: false, error: error.message });
    }

    // Rate limit delay between channels (skip after last)
    if (i < selected.length - 1) {
      updateProgress(i + 1, selected.length, 'Waiting (rate limit)...');
      setActivity('Waiting for rate limit...');
      await sleep(2500);
    }
  }

  // Download combined file if enabled
  if (combinedExportCb.checked && combinedMarkdown) {
    const now = new Date();
    const header = `# Slack Export Extension Combined Export\n*Exported: ${now.toLocaleString()}*\n`;
    try {
      await chrome.runtime.sendMessage({
        action: 'DOWNLOAD_FILE',
        data: {
          filename: generateFilename('combined'),
          content: header + combinedMarkdown,
          directory: config.downloadDirectory || 'slack-exports'
        }
      });
    } catch (e) {
      console.error('Failed to download combined file:', e);
    }
  }

  // Show summary
  activeExportChannelId = null;
  updateProgress(selected.length, selected.length, 'Done!');
  setActivity('Export complete');
  setLiveStats(completedStats.messages, completedStats.attachments);
  if (progressSpinner) progressSpinner.style.animationPlayState = 'paused';
  showSummary(results);
  await notifyExportSession('finish');

  isExporting = false;

  // Re-enable checkboxes
  channelListEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    const channelId = cb.dataset.channelId;
    const ch = channels.find(c => c.channelId === channelId);
    if (ch && ch.enabled && ch.channelId) {
      cb.disabled = false;
    }
    // Tier checkboxes
    if (cb.dataset.tier && !cb.dataset.channelId) {
      cb.disabled = false;
    }
  });
  // Also re-enable tier-level checkboxes
  channelListEl.querySelectorAll('.tier-header input[type="checkbox"]').forEach(cb => {
    cb.disabled = false;
  });

  exportControls.style.display = 'block';
  updateExportButton();
}

// ── Progress & status helpers ──────────────────────────────────────

function updateProgress(current, total, label) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  progressBar.style.width = `${pct}%`;
  progressText.textContent = label
    ? `${current}/${total} — ${label}`
    : `${current}/${total} channels exported`;
}

function setActivity(text) {
  if (activityText) activityText.textContent = text || '';
}

function setLiveStats(messages, attachments) {
  liveStats.messages = Number(messages || 0);
  liveStats.attachments = Number(attachments || 0);
  if (progressMessages) progressMessages.textContent = `Messages: ${liveStats.messages}`;
  if (progressAttachments) progressAttachments.textContent = `Attachments: ${liveStats.attachments}`;
}

function handleLiveProgressUpdate(message) {
  const stage = message.stage || '';
  if (typeof message.messageCount === 'number' || typeof message.attachmentCount === 'number') {
    channelLiveStats.messages = Math.max(channelLiveStats.messages, Number(message.messageCount || 0));
    channelLiveStats.attachments = Math.max(channelLiveStats.attachments, Number(message.attachmentCount || 0));
    setLiveStats(
      completedStats.messages + channelLiveStats.messages,
      completedStats.attachments + channelLiveStats.attachments
    );
  }

  if (stage === 'fetching_messages') {
    setActivity('Fetching messages from Slack API...');
  } else if (stage === 'fetching_thread_replies') {
    setActivity(`Fetching thread replies (${message.fetchedThreads || 0}/${message.totalThreads || 0})...`);
  } else if (stage === 'enriching_messages') {
    setActivity(`Processing messages (${message.processed || 0}/${message.total || 0})...`);
  } else if (stage === 'downloading_attachments') {
    setActivity(`Downloading attachments (${message.downloaded || 0}/${message.total || 0})...`);
  } else if (stage === 'building_markdown') {
    setActivity('Building markdown files...');
  } else if (stage === 'done') {
    setActivity('Channel export finished');
  }
}

async function notifyExportSession(event, extra = {}) {
  try {
    await chrome.runtime.sendMessage({
      action: 'BATCH_EXPORT_SESSION',
      event,
      ...extra
    });
  } catch (error) {
    console.warn('Failed to sync export session state:', error);
  }
}

async function restoreExportUiState() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'GET_BATCH_EXPORT_STATE' });
    const state = response?.state;
    if (!response?.success || !state) return;

    if (state.channelStatuses && typeof state.channelStatuses === 'object') {
      for (const [channelId, status] of Object.entries(state.channelStatuses)) {
        if (status === 'active' || status === 'success' || status === 'error') {
          setChannelStatus(channelId, status);
        }
      }
    }

    if (!state.active) return;

    isExporting = true;
    exportBtn.disabled = true;
    progressSection.style.display = 'block';
    exportControls.style.display = 'none';
    summarySection.style.display = 'none';

    activeExportChannelId = state.currentChannelId || null;
    completedStats.messages = Number(state.messageCount || 0);
    completedStats.attachments = Number(state.attachmentCount || 0);
    channelLiveStats = { messages: 0, attachments: 0 };
    setLiveStats(completedStats.messages, completedStats.attachments);
    if (progressSpinner) progressSpinner.style.animationPlayState = 'running';

    if (typeof state.progressPercent === 'number') {
      progressBar.style.width = `${Math.max(0, Math.min(100, state.progressPercent))}%`;
    }

    if (state.totalChannels > 0) {
      progressText.textContent = `${state.completedChannels || 0}/${state.totalChannels} — ${state.currentChannelName || 'Export in progress'}`;
    } else {
      progressText.textContent = 'Export in progress...';
    }

    const stage = String(state.stage || '');
    if (stage === 'fetching_thread_replies') {
      setActivity(`Fetching thread replies (${state.fetchedThreads || 0}/${state.totalThreads || 0})...`);
    } else if (stage === 'downloading_attachments') {
      setActivity('Downloading attachments...');
    } else if (stage === 'enriching_messages') {
      setActivity('Processing messages...');
    } else if (stage === 'building_markdown') {
      setActivity('Building markdown files...');
    } else {
      setActivity(state.activityText || 'Export in progress...');
    }

    channelListEl.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.disabled = true; });
  } catch (error) {
    console.warn('Failed to restore export UI state:', error);
  }
}

function setChannelStatus(channelId, status) {
  const el = document.getElementById(`status-${channelId}`);
  if (!el) return;
  el.className = `channel-status ${status}`;
  if (status === 'active') {
    el.innerHTML = '<span class="spinner"></span>';
  } else if (status === 'success') {
    el.textContent = '\u2713';
  } else if (status === 'error') {
    el.textContent = '\u2717';
  } else {
    el.textContent = '';
  }
}

function showSummary(results) {
  const successes = results.filter(r => r.success);
  const failures = results.filter(r => !r.success);
  const totalMessages = successes.reduce((sum, r) => sum + (r.count || 0), 0);
  const totalAttachments = successes.reduce((sum, r) => sum + (r.attachments || 0), 0);

  let html = '';
  if (failures.length === 0) {
    html = `Exported ${successes.length} channel${successes.length !== 1 ? 's' : ''} (${totalMessages} messages, ${totalAttachments} attachments)`;
    summarySection.className = 'summary-section';
  } else {
    html = `${successes.length} exported, ${failures.length} failed`;
    if (failures.length > 0) {
      html += '<br>' + failures.map(f => `${f.channel}: ${f.error}`).join('<br>');
    }
    summarySection.className = 'summary-section has-errors';
  }

  summarySection.innerHTML = html;
  summarySection.style.display = 'block';
}

function refreshChannelLastExportMeta(channelId) {
  const item = channelListEl.querySelector(`.channel-item[data-channel-id="${channelId}"]`);
  if (!item) return;
  const meta = item.querySelector('.channel-meta');
  if (!meta) return;
  meta.textContent = formatLastExported(channelId);
  meta.style.color = '';
}

// ── Quick-add current channel ──────────────────────────────────────

async function quickAddCurrentChannel() {
  if (!activeTab) return;
  quickAddBtn.disabled = true;
  quickAddBtn.textContent = 'Detecting...';

  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      action: 'GET_CURRENT_CHANNEL'
    });

    if (response && response.channelId && isSlackConversationId(response.channelId)) {
      // Check if already exists
      const existing = channels.find(c => c.channelId === response.channelId);
      if (existing) {
        quickAddBtn.textContent = `Already added: ${existing.name}`;
        setTimeout(() => {
          quickAddBtn.textContent = '+ Add current channel';
          quickAddBtn.disabled = false;
        }, 2000);
        return;
      }

      const newChannel = {
        name: response.channelName || response.channelId,
        channelId: response.channelId,
        tier: 1,
        type: inferChannelType(response.channelId),
        enabled: true
      };

      channels.push(newChannel);
      await saveConfig({ channels });

      quickAddBtn.textContent = `Added: ${newChannel.name}`;
      renderChannels();
      updateExportButton();

      setTimeout(() => {
        quickAddBtn.textContent = '+ Add current channel';
        quickAddBtn.disabled = false;
      }, 2000);
    } else if (response && response.channelId) {
      quickAddBtn.textContent = 'Could not resolve conversation ID';
      setTimeout(() => {
        quickAddBtn.textContent = '+ Add current channel';
        quickAddBtn.disabled = false;
      }, 2000);
    } else {
      quickAddBtn.textContent = 'Could not detect channel';
      setTimeout(() => {
        quickAddBtn.textContent = '+ Add current channel';
        quickAddBtn.disabled = false;
      }, 2000);
    }
  } catch (error) {
    console.error('Quick-add failed:', error);
    quickAddBtn.textContent = 'Error - try again';
    setTimeout(() => {
      quickAddBtn.textContent = '+ Add current channel';
      quickAddBtn.disabled = false;
    }, 2000);
  }
}

async function cleanupInvalidChannels() {
  if (isExporting) return;

  const invalidChannels = channels.filter(ch => !isSlackConversationId(ch.channelId));
  if (invalidChannels.length === 0) {
    cleanupChannelsBtn.textContent = 'No invalid channels';
    setTimeout(() => {
      cleanupChannelsBtn.textContent = 'Clean invalid channels';
    }, 1800);
    return;
  }

  cleanupChannelsBtn.disabled = true;
  cleanupChannelsBtn.textContent = `Cleaning ${invalidChannels.length}...`;

  try {
    channels = channels.filter(ch => isSlackConversationId(ch.channelId));

    const validChannelIds = new Set(channels.map(ch => ch.channelId));
    lastExportTimestamps = Object.fromEntries(
      Object.entries(lastExportTimestamps).filter(([channelId]) => validChannelIds.has(channelId))
    );

    await saveConfig({ channels, lastExportTimestamps });

    renderChannels();
    updateExportButton();
    summarySection.className = 'summary-section';
    summarySection.innerHTML = `Removed ${invalidChannels.length} invalid channel${invalidChannels.length === 1 ? '' : 's'}`;
    summarySection.style.display = 'block';

    cleanupChannelsBtn.textContent = `Removed ${invalidChannels.length}`;
  } catch (error) {
    console.error('Failed to clean channels:', error);
    cleanupChannelsBtn.textContent = 'Cleanup failed';
  } finally {
    setTimeout(() => {
      cleanupChannelsBtn.textContent = 'Clean invalid channels';
      cleanupChannelsBtn.disabled = false;
    }, 1800);
  }
}

// ── Utility functions ──────────────────────────────────────────────

function formatLastExported(channelId) {
  const ts = lastExportTimestamps[channelId];
  if (!ts) return 'never';

  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

function generateFilename(channelName) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const dateStr = `${yyyy}${mm}${dd}-${hh}${min}`;
  const cleanChannel = channelName.replace(/[^a-zA-Z0-9\-_]/g, '-').replace(/-+/g, '-').toLowerCase();

  const fmt = (config.fileNameFormat || 'YYYYMMDD-HHmm-{channel}.md');
  return fmt.replace('YYYYMMDD-HHmm', dateStr).replace('{channel}', cleanChannel);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function isSlackConversationId(value) {
  return /^[CDG][A-Z0-9]{8,}$/i.test(String(value || '').trim());
}

function inferChannelType(channelId) {
  const id = String(channelId || '').toUpperCase();
  if (id.startsWith('D')) return 'dm';
  if (id.startsWith('G')) return 'group';
  return 'channel';
}

/**
 * Try to load personal channel config from channels.local.json.
 * Returns the parsed array if the file exists, or null to fall back to INITIAL_CHANNELS.
 */
async function loadLocalChannels() {
  try {
    const url = chrome.runtime.getURL('channels.local.json');
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    if (Array.isArray(data) && data.length > 0) {
      console.log(`Loaded ${data.length} channels from channels.local.json`);
      return data;
    }
    return null;
  } catch (e) {
    // File doesn't exist or isn't valid JSON — expected for most users
    return null;
  }
}
