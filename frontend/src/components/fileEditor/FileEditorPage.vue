<script setup lang="ts">
/**
 * FileEditorPage.vue - 独立文件编辑窗口（桌面版「打开为新页面」）
 *
 * 由主进程创建独立 BrowserWindow 后，App.vue 按 __GRAYCODE_VIEW_MODE === 'fileEditor'
 * 渲染本页面。完全自包含：不初始化主聊天时间线，不依赖设置加载——
 * 读取/保存经 IPC（readFileForContext / fileEditor.saveFile）完成，
 * 响应按窗口自身 clientId（__GRAYCODE_WEBVIEW_CLIENT_ID）精确路由回本窗口。
 */
import { computed, onMounted, ref } from 'vue'
import { MESSAGE_NAMES } from '@shared/protocol'
import { sendToExtension } from '@/utils/vscode'

const filePath = ref(window.__GRAYCODE_FILE_PATH || '')
const clientId = window.__GRAYCODE_WEBVIEW_CLIENT_ID
const content = ref('')
const originalContent = ref('')
const loading = ref(true)
const error = ref('')
const saving = ref(false)
const saveMessage = ref('')
const saveMessageType = ref<'success' | 'error'>('success')

const dirty = computed(() => content.value !== originalContent.value)
const fileName = computed(() => {
  const p = filePath.value.replace(/\\/g, '/')
  return p.split('/').pop() || p
})
const lineCount = computed(() => (content.value ? content.value.split('\n').length : 0))
const charCount = computed(() => content.value.length)

const T = (zh: string, en: string): string =>
  (navigator.language || '').toLowerCase().startsWith('zh') ? zh : en

/** 与 codeViewStore.resolveFileUri 同口径：相对/绝对路径 → file:// URI（相对拼接工作区根） */
async function resolveFileUri(target: string): Promise<string> {
  const trimmed = target.trim()
  if (trimmed.startsWith('file://') || /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/')) {
    return trimmed.startsWith('file://') ? trimmed : 'file://' + trimmed.replace(/^[/\\]+/, '')
  }
  try {
    const wsUri = await sendToExtension<string | null>('getWorkspaceUri', {}, { clientId })
    if (wsUri) return `${wsUri}/${trimmed}`
  } catch {
    // 获取工作区失败：按原样解析，由后端校验兜底
  }
  return 'file://' + trimmed
}

async function loadFile(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const uri = await resolveFileUri(filePath.value)
    const response = await sendToExtension<{
      success: boolean
      content?: string
      path?: string
      error?: string
    }>(MESSAGE_NAMES.readFileForContext, { uri }, { clientId })
    if (!response?.success) {
      error.value = response?.error || T('读取文件失败', 'Failed to read file')
      return
    }
    content.value = response.content || ''
    originalContent.value = response.content || ''
  } catch (err: any) {
    error.value = err?.message || String(err)
  } finally {
    loading.value = false
  }
}

async function saveFile(): Promise<void> {
  if (saving.value) return
  saving.value = true
  saveMessage.value = ''
  try {
    const response = await sendToExtension<{
      success: boolean
      path?: string
      error?: string
    }>(MESSAGE_NAMES['fileEditor.saveFile'], { path: filePath.value, content: content.value }, { clientId })
    if (!response?.success) {
      saveMessage.value = response?.error || T('保存失败', 'Save failed')
      saveMessageType.value = 'error'
      return
    }
    originalContent.value = content.value
    saveMessage.value = T('已保存', 'Saved')
    saveMessageType.value = 'success'
    setTimeout(() => {
      if (saveMessage.value === T('已保存', 'Saved')) saveMessage.value = ''
    }, 2000)
  } catch (err: any) {
    saveMessage.value = err?.message || T('保存失败', 'Save failed')
    saveMessageType.value = 'error'
  } finally {
    saving.value = false
  }
}

function closeWindow(): void {
  if (dirty.value && !window.confirm(T('有未保存的更改，确定关闭吗？', 'You have unsaved changes. Close anyway?'))) {
    return
  }
  window.close()
}

function handleKeydown(e: KeyboardEvent): void {
  // Ctrl+S / Cmd+S 保存
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault()
    void saveFile()
  }
}

onMounted(() => {
  void loadFile()
})
</script>

<template>
  <div class="file-editor-root">
    <header class="fe-header">
      <span class="codicon codicon-code fe-header-icon"></span>
      <span class="fe-title" :title="filePath">{{ fileName }}</span>
      <span v-if="dirty" class="fe-dirty-dot" :title="T('有未保存的更改', 'Unsaved changes')">●</span>
      <span class="fe-path" :title="filePath">{{ filePath }}</span>

      <div class="fe-actions">
        <button
          class="fe-btn primary"
          type="button"
          :disabled="saving || loading || !dirty"
          :title="T('保存 (Ctrl+S)', 'Save (Ctrl+S)')"
          @click="saveFile"
        >
          <i v-if="saving" class="codicon codicon-loading codicon-modifier-spin"></i>
          <i v-else class="codicon codicon-save"></i>
          {{ T('保存', 'Save') }}
        </button>
        <button
          class="fe-btn"
          type="button"
          :title="T('关闭', 'Close')"
          @click="closeWindow"
        ><i class="codicon codicon-close"></i>
        </button>
      </div>
    </header>

    <div class="fe-statusbar">
      <span v-if="saveMessage" class="fe-save-message" :class="saveMessageType">{{ saveMessage }}</span>
      <span v-else-if="dirty" class="fe-dirty-hint">{{ T('未保存', 'Unsaved') }}</span>
      <span class="fe-stats">{{ T('行数', 'Lines') }} {{ lineCount }} · {{ T('字符', 'Chars') }} {{ charCount }}</span>
    </div>

    <div class="fe-body">
      <div v-if="loading" class="fe-loading">
        <i class="codicon codicon-loading spin"></i>
        <span>{{ T('加载中…', 'Loading…') }}</span>
      </div>

      <div v-else-if="error" class="fe-error">
        <span class="codicon codicon-error"></span>
        <span>{{ error }}</span>
      </div>

      <textarea
        v-else
        v-model="content"
        class="fe-editor"
        spellcheck="false"
        :placeholder="T('在此编辑文件…', 'Edit the file here…')"
        @keydown="handleKeydown"
      ></textarea>
    </div>
  </div>
</template>

<style scoped>
.file-editor-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--vscode-editor-background, #1e1e1e);
  color: var(--vscode-foreground, #cccccc);
  font-family: var(--vscode-font-family, sans-serif);
}

.fe-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
  border-bottom: 1px solid var(--vscode-widget-border, #454545);
}

.fe-header-icon {
  color: var(--vscode-textLink-foreground, #3794ff);
}

.fe-title {
  flex: none;
  font-weight: 600;
  font-size: 13px;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fe-dirty-dot {
  flex: none;
  color: var(--vscode-charts-yellow, #f0c674);
  font-size: 12px;
}

.fe-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #9d9d9d);
}

.fe-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

.fe-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--vscode-button-border, rgba(255, 255, 255, 0.07));
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #ffffff);
  border-radius: 3px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  line-height: 1.4;
}

.fe-btn:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground, #45494e);
}

.fe-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.fe-btn.primary {
  background: var(--vscode-button-background, #0e639c);
}

.fe-btn.primary:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground, #1177bb);
}

.fe-statusbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 3px 12px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  background: var(--vscode-statusBar-background, #007acc);
  color: var(--vscode-statusBar-foreground, #ffffff);
}

.fe-save-message.success {
  color: var(--vscode-statusBar-foreground, #ffffff);
  font-weight: 600;
}

.fe-save-message.error {
  color: #f48771;
  font-weight: 600;
}

.fe-dirty-hint {
  font-style: italic;
}

.fe-stats {
  margin-left: auto;
}

.fe-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.fe-loading,
.fe-error {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--vscode-descriptionForeground, #9d9d9d);
}

.fe-error {
  color: #f48771;
}

.fe-editor {
  flex: 1;
  min-height: 0;
  width: 100%;
  box-sizing: border-box;
  resize: none;
  border: none;
  outline: none;
  padding: 12px 16px;
  background: var(--vscode-editor-background, #1e1e1e);
  color: var(--vscode-editor-foreground, #cccccc);
  font-family: var(--vscode-editor-font-family, Consolas, 'Courier New', monospace);
  font-size: var(--vscode-editor-font-size, 13px);
  line-height: 1.6;
  tab-size: 2;
  white-space: pre;
  overflow: auto;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>
