/**
 * ModelsHandler.updateModel / ConfigHandlers updateModel 回归测试
 *
 * 背景：新增「编辑 AI 信息」功能（设置 → 渠道 → 模型管理器），支持修改已有模型的
 * name/description。后端经 ConfigManager.updateModels 原子合并按 id 定位替换；
 * webview 层成功后推送 channels.configChanged（与 addModels/removeModel 一致），
 * 输入区/任务卡/工具面板的模型下拉框即时刷新。
 * 本测试锁住「按 id 局部更新、其余字段保留、错误路径、成功推送」的行为。
 */

import { ModelsHandler } from '../../../backend/modules/api/models/ModelsHandler';
import {
    updateModel,
} from '../../../webview/handlers/ConfigHandlers';
import { PUSH_MESSAGE_NAMES } from '../../../shared/protocol';
import type { HandlerContext } from '../../../webview/types';

// ========== ModelsHandler.updateModel（后端） ==========

function createBackendDeps(overrides: Record<string, unknown> = {}) {
    const configManager = {
        getConfig: jest.fn(),
        updateModels: jest.fn(),
        ...overrides,
    };
    const settingsManager = {};
    const handler = new ModelsHandler(configManager as any, settingsManager as any);
    return { configManager, handler };
}

describe('ModelsHandler.updateModel', () => {
    test('按 id 更新 name/description，其余字段保留，未传字段保持原值', async () => {
        const { configManager, handler } = createBackendDeps();
        configManager.getConfig.mockResolvedValue({
            id: 'cfg-1',
            models: [
                { id: 'm1', name: '旧名', description: '旧描述', contextWindow: 8192 },
                { id: 'm2', name: 'm2', maxOutputTokens: 4096 },
            ],
        });
        configManager.updateModels.mockImplementation(async (_configId: string, mergeFn: (current: any[]) => any[]) => {
            const merged = mergeFn([
                { id: 'm1', name: '旧名', description: '旧描述', contextWindow: 8192 },
                { id: 'm2', name: 'm2', maxOutputTokens: 4096 },
            ]);
            return { models: merged };
        });

        const result = await handler.updateModel({
            configId: 'cfg-1',
            modelId: 'm1',
            name: '新名',
            description: '新描述',
        });

        expect(result.success).toBe(true);
        const mergeFn = configManager.updateModels.mock.calls[0][1] as (current: any[]) => any[];
        const merged = mergeFn([
            { id: 'm1', name: '旧名', description: '旧描述', contextWindow: 8192 },
            { id: 'm2', name: 'm2', maxOutputTokens: 4096 },
        ]);
        // m1 更新：name/description 替换，contextWindow 保留
        expect(merged[0]).toEqual({ id: 'm1', name: '新名', description: '新描述', contextWindow: 8192 });
        // m2 不受影响
        expect(merged[1]).toEqual({ id: 'm2', name: 'm2', maxOutputTokens: 4096 });
    });

    test('只传 name 时 description 保持原值（未传字段不动）', async () => {
        const { configManager, handler } = createBackendDeps();
        configManager.getConfig.mockResolvedValue({
            id: 'cfg-1',
            models: [{ id: 'm1', name: '旧名', description: '旧描述' }],
        });

        const result = await handler.updateModel({ configId: 'cfg-1', modelId: 'm1', name: '新名' });

        expect(result.success).toBe(true);
        const mergeFn = configManager.updateModels.mock.calls[0][1] as (current: any[]) => any[];
        const merged = mergeFn([{ id: 'm1', name: '旧名', description: '旧描述' }]);
        expect(merged[0]).toEqual({ id: 'm1', name: '新名', description: '旧描述' });
    });

    test('配置不存在返回 CONFIG_NOT_FOUND，不触发写入', async () => {
        const { configManager, handler } = createBackendDeps();
        configManager.getConfig.mockResolvedValue(null);

        const result = await handler.updateModel({ configId: 'missing', modelId: 'm1', name: 'x' });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('CONFIG_NOT_FOUND');
        expect(configManager.updateModels).not.toHaveBeenCalled();
    });

    test('模型不在列表返回 MODEL_NOT_IN_LIST，不触发写入', async () => {
        const { configManager, handler } = createBackendDeps();
        configManager.getConfig.mockResolvedValue({ id: 'cfg-1', models: [{ id: 'm1' }] });

        const result = await handler.updateModel({ configId: 'cfg-1', modelId: 'ghost', name: 'x' });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('MODEL_NOT_IN_LIST');
        expect(configManager.updateModels).not.toHaveBeenCalled();
    });

    test('写失败返回 UPDATE_MODEL_FAILED', async () => {
        const { configManager, handler } = createBackendDeps();
        configManager.getConfig.mockResolvedValue({ id: 'cfg-1', models: [{ id: 'm1' }] });
        configManager.updateModels.mockRejectedValue(new Error('boom'));

        const result = await handler.updateModel({ configId: 'cfg-1', modelId: 'm1', name: 'x' });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('UPDATE_MODEL_FAILED');
    });
});

// ========== ConfigHandlers.updateModel（webview 层） ==========

function createHandlerContext(overrides: Record<string, unknown> = {}) {
    const postMessage = jest.fn(() => true);
    const sendResponse = jest.fn();
    const sendError = jest.fn();

    const ctx: HandlerContext = {
        configManager: {
            getConfig: jest.fn().mockResolvedValue({ id: 'cfg-1', models: [] }),
            updateModels: jest.fn().mockResolvedValue({ success: true }),
        },
        modelsHandler: {
            updateModel: jest.fn().mockResolvedValue({ success: true }),
        },
        postMessage,
        sendResponse,
        sendError,
        ...overrides,
    } as any;

    return { ctx, postMessage, sendResponse, sendError };
}

function changedCommand(configId?: string) {
    return {
        type: PUSH_MESSAGE_NAMES.command,
        command: PUSH_MESSAGE_NAMES['channels.configChanged'],
        data: configId ? { configId } : {},
    };
}

describe('ConfigHandlers updateModel', () => {
    test('成功时推送 channels.configChanged（携带 configId）', async () => {
        const { ctx, postMessage, sendResponse } = createHandlerContext();
        await updateModel(
            { configId: 'cfg-1', modelId: 'm1', name: '新名' },
            'req-1',
            ctx
        );
        expect(ctx.modelsHandler.updateModel).toHaveBeenCalledWith({
            configId: 'cfg-1',
            modelId: 'm1',
            name: '新名',
        });
        expect(sendResponse).toHaveBeenCalledWith('req-1', { success: true });
        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining(changedCommand('cfg-1')));
    });

    test('缺少 modelId 直接报错，不调用后端', async () => {
        const { ctx, sendError } = createHandlerContext();
        await updateModel({ configId: 'cfg-1' }, 'req-2', ctx);
        expect(sendError).toHaveBeenCalled();
        expect(ctx.modelsHandler.updateModel).not.toHaveBeenCalled();
    });

    test('后端返回失败时透传错误', async () => {
        const { ctx, sendError } = createHandlerContext({
            modelsHandler: {
                updateModel: jest.fn().mockResolvedValue({
                    success: false,
                    error: { code: 'MODEL_NOT_IN_LIST', message: 'not in list' },
                }),
            },
        });
        await updateModel(
            { configId: 'cfg-1', modelId: 'ghost', name: 'x' },
            'req-3',
            ctx
        );
        expect(sendError).toHaveBeenCalledWith(
            'req-3',
            'UPDATE_MODEL_ERROR',
            expect.stringContaining('not in list')
        );
    });
});
