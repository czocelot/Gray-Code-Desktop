<script setup lang="ts">
/**
 * FileEditorPage.vue - 文件编辑标签页（桌面版「打开为新页面」）
 *
 * 与对话标签页同级的文件编辑器页签：由 chatStore.openFileTab 创建 kind='file'
 * 标签页，App.vue 按当前激活标签页类型渲染本组件。读取经 readFileForContext、
 * 保存经 fileEditor.saveFile（后端工作区包含校验 + realpath 复核），
 * 消息走主窗口默认路由（无独立 clientId）。
 */
import { computed, ref, watch } from 'vue'
import { MESSAGE_NAMES } from '@shared/protocol'
import { sendToExtension } from '@/utils/vscode'
import { useCodeViewStore } from '@/stores/codeViewStore'
import { ConfirmDialog } from '../common'

const props = defineProps<{ filePath: string }>()
const emit = defineEmits<{ close: []; 'dirty-change': [dirty: boolean] }>()

const content = ref('')
const originalContent = ref('')
const loading = ref(true)
const error = ref('')
const saving = ref(false)
const saveMessage = ref('')
const saveMessageType = ref<'success' | 'error'>('success')

const dirty = computed(() => content.value !== originalContent.value)
// 脏状态变化上报父组件（tab 栏关闭按钮的未保存确认依赖它）
watch(dirty, (d) => emit('dirty-change', d))
const fileName = computed(() => {
  const p = props.filePath.replace(/\\/g, '/')
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
    const wsUri = await sendToExtension<string | null>('getWorkspaceUri', {})
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
    const uri = await resolveFileUri(props.filePath)
    const response = await sendToExtension<{
      success: boolean
      content?: string
      path?: string
      error?: string
    }>(MESSAGE_NAMES.readFileForContext, { uri })
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
    }>(MESSAGE_NAMES['fileEditor.saveFile'], { path: props.filePath, content: content.value })
    if (!response?.success) {
      saveMessage.value = response?.error || T('保存失败', 'Save failed')
      saveMessageType.value = 'error'
      return
    }
    originalContent.value = content.value
    saveMessage.value = T('已保存', 'Saved')
    saveMessageType.value = 'success'
    // 保存成功：若代码查看器正打开同一文件，立即刷新其显示（磁盘内容已更新）
    try {
      const codeViewStore = useCodeViewStore()
      if (codeViewStore.source === 'disk' && codeViewStore.path === props.filePath) {
        void codeViewStore.refresh()
      }
    } catch {
      // 刷新失败不影响保存结果
    }
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

/** 关闭标签页：有未保存更改时先经自研 ConfirmDialog 确认（window.confirm 在 Electron
 *  渲染进程同步阻塞且行为不可靠——确认后可能返回异常导致标签页无法关闭，界面表现为
 *  「卡住」）；无未保存更改直接关闭。 */
const showCloseConfirm = ref(false)
function closeTab(): void {
  if (dirty.value) {
    showCloseConfirm.value = true
    return
  }
  emit('close')
}

function handleKeydown(e: KeyboardEvent): void {
  // Ctrl+S / Cmd+S 保存
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault()
    void saveFile()
  }
}

// 文件路径变化（同一标签页复用）时重新加载
watch(() => props.filePath, () => {
  void loadFile()
}, { immediate: true })
</script>

<template>
  <div class="file-editor-root">
    <header class="fe-header">
      <span class="codicon codicon-code fe-header-icon"></span>
      <span class="fe-title" :title="props.filePath">{{ fileName }}</span>
      <span v-if="dirty" class="fe-dirty-dot" :title="T('有未保存的更改', 'Unsaved changes')">●</span>
      <span class="fe-path" :title="props.filePath">{{ props.filePath }}</span>

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
          :title="T('关闭标签页', 'Close tab')"
          @click="closeTab"
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

    <!-- 未保存更改关闭确认（自研纯 DOM 确认框，避免 Electron window.confirm 卡住） -->
    <ConfirmDialog
      v-model="showCloseConfirm"
      :title="T('有未保存的更改', 'Unsaved changes')"
      :message="T('有未保存的更改，确定关闭吗？更改将不会保存。', 'You have unsaved changes. Close anyway? Changes will not be saved.')"
      :confirm-text="T('确定关闭', 'Close anyway')"
      :is-danger="true"
      @confirm="emit('close')"
    />
  </div>
</template>

<style scoped>
.file-editor-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  /* 半透明背景由 ::before 伪元素承担（background: transparent + 伪元素 opacity）：
     color-mix 在 Chromium 按定义点解析（:root 加载时锁定 --gc-ui-opacity=1），
     直接 background: var(--gc-surface-editor-bg) 无法实时跟随 UI 不透明度；
     opacity: var(--gc-ui-opacity) 惰性解析、实时生效，透出桌面背景图/窗口背景 */
  position: relative;
  isolation: isolate;
  background: transparent;
  color: var(--vscode-foreground, #cccccc);
  font-family: var(--vscode-font-family, sans-serif);
}

/* 半透明背景层：z-index:-1 保持在内容之下（isolation 上下文内），文字/图标全不透明 */
.file-editor-root::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  background: var(--vscode-editor-background, #1e1e1e);
  /* 独立于全局 UI 不透明度：--gc-editor-opacity 优先（文件编辑界面独立滑条）；
     未配置时回退 --gc-ui-opacity（跟随全局），保持旧行为不变 */
  opacity: var(--gc-editor-opacity, var(--gc-ui-opacity, 1));
  pointer-events: none;
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
  /* 透明：透出 .file-editor-root::before 半透明背景层（跟随 UI 不透明度） */
  background: transparent;
  color: var(--vscode-editor-foreground, #cccccc);
  font-family: var(--vscode-editor-font-family, Consolas, 'Courier New', monospace);
  font-size: var(--gc-editor-font-size, var(--vscode-editor-font-size, 13px));
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
