/**
 * 文件编辑新窗口消息处理器（桌面版「打开为新页面」）
 *
 * - openFileEditorWindow：主窗口代码查看面板请求主进程打开独立文件编辑新窗口。
 *   实际窗口创建由主进程完成（BackendHost options.onOpenFileEditorWindow → main.ts
 *   createFileEditorWindow）；VS Code 宿主不注入该回调，调用返回 false。
 * - saveFileEditorContent：新窗口编辑完成后保存（相对/绝对路径 → file:// URI →
 *   工作区包含校验（realpath 感知）→ 写入）。
 *
 * 安全约束（与 readWorkspaceTextFile / writeWorkspaceTextFile 同口径）：
 * - 目标必须位于已打开的工作区内（getRelativePathFromAbsolute + realpath 复核）；
 * - 内容大小上限与读取上限一致（10MB）；
 * - 目标父目录不存在时自动创建（与 saveImageToPath 行为一致）。
 */

import { MESSAGE_NAMES } from '../../../shared/protocol';
import * as vscode from 'vscode';
import * as path from 'path';
import { t } from '../../../backend/i18n';
import type { MessageHandler } from '../../types';
import { isUriInsideWorkspaceRealpath, MAX_TEXT_FILE_SIZE_BYTES } from './fileHandlerUtils';
import { getRelativePathFromAbsolute } from '../../utils/WorkspaceUtils';
import { resolveTargetWorkspaceFolder } from '../FileHandlers';

// ========== 打开独立编辑新窗口 ==========

export const openFileEditorWindow: MessageHandler = async (data, requestId, ctx) => {
  try {
    const filePath = typeof data?.path === 'string' ? data.path : '';
    if (!filePath.trim()) {
      ctx.sendResponse(requestId, { success: false, error: t('webview.errors.invalidFileUri') });
      return;
    }
    if (typeof ctx.openFileEditorWindow !== 'function') {
      // VS Code 宿主：无独立窗口能力，静默成功（按钮在桌面版才显示，正常不会走到）
      ctx.sendResponse(requestId, { success: false, error: 'Not supported on this host' });
      return;
    }
    try {
      ctx.openFileEditorWindow(filePath);
    } catch (err) {
      console.error('[FileEditorHandlers] openFileEditorWindow failed:', err);
    }
    ctx.sendResponse(requestId, { success: true, path: filePath });
  } catch (error: any) {
    ctx.sendResponse(requestId, {
      success: false,
      error: error.message || t('webview.errors.readFileFailed')
    });
  }
};

// ========== 保存文件编辑内容 ==========

/**
 * 把编辑内容写回工作区文件。
 *
 * path 支持三种形态：
 * - file:// URI（原样解析）
 * - 绝对路径（含盘符/UNC/POSIX 根路径）
 * - 相对路径（拼接当前工作区根目录）
 * 统一解析为 vscode.Uri 后做工作区包含校验与 realpath 复核。
 */
export const saveFileEditorContent: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { path: filePath, content } = data || {};
    if (typeof filePath !== 'string' || typeof content !== 'string') {
      ctx.sendResponse(requestId, { success: false, error: t('webview.errors.invalidFileUri') });
      return;
    }

    // 解析为 file:// URI
    let fileUri: vscode.Uri;
    try {
      if (filePath.startsWith('file://')) {
        fileUri = vscode.Uri.parse(filePath);
      } else if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('/')) {
        // Windows 盘符 / UNC / POSIX 绝对路径
        fileUri = vscode.Uri.file(filePath);
      } else {
        const workspaceFolder = resolveTargetWorkspaceFolder(ctx);
        if (!workspaceFolder) {
          ctx.sendResponse(requestId, { success: false, error: t('webview.errors.noWorkspaceOpen') });
          return;
        }
        fileUri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
      }
    } catch {
      ctx.sendResponse(requestId, { success: false, error: t('webview.errors.invalidFileUri') });
      return;
    }

    // 工作区包含校验（词法 + realpath 复核）
    const relativePath = getRelativePathFromAbsolute(fileUri.fsPath);
    if (!relativePath) {
      ctx.sendResponse(requestId, { success: false, error: t('webview.errors.fileNotInWorkspace') });
      return;
    }
    if (!(await isUriInsideWorkspaceRealpath(fileUri))) {
      ctx.sendResponse(requestId, { success: false, error: t('webview.errors.fileNotInWorkspace') });
      return;
    }

    if (Buffer.byteLength(content, 'utf-8') > MAX_TEXT_FILE_SIZE_BYTES) {
      ctx.sendResponse(requestId, { success: false, error: t('webview.errors.readFileFailed') });
      return;
    }

    // 父目录不存在时自动创建（写入新文件场景）
    const dirUri = vscode.Uri.joinPath(fileUri, '..');
    try {
      await vscode.workspace.fs.createDirectory(dirUri);
    } catch {
      // 目录可能已存在或不可创建：写入时再抛错
    }

    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf-8'));
    ctx.sendResponse(requestId, { success: true, path: relativePath });
  } catch (error: any) {
    ctx.sendResponse(requestId, {
      success: false,
      error: error.message || t('webview.errors.readFileFailed')
    });
  }
};

// ========== 注册 ==========

export function registerFileEditorHandlers(registry: Map<string, MessageHandler>): void {
  registry.set(MESSAGE_NAMES['fileEditor.openWindow'], openFileEditorWindow);
  registry.set(MESSAGE_NAMES['fileEditor.saveFile'], saveFileEditorContent);
}
