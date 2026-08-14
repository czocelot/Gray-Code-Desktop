/**
 * conversation.updateMessage 处理器（AI 消息文本原地改写）单元测试
 *
 * 覆盖：注册表注册；成功改写（updateMessage 收到 parts 替换并返回 success）；
 *      入参校验（缺会话 / 非法索引 / 空文本）；稳定消息 ID 预检（索引漂移 →
 *      MESSAGE_CHANGED，不落盘）；异常路径返回明确错误码。
 */

import {
    updateMessage,
    registerChatHandlers
} from '../../../webview/handlers/ChatHandlers';
import { createMessageHandlerRegistry } from '../../../webview/handlers';

function createCtx(overrides: Record<string, unknown> = {}) {
    const sendResponse = jest.fn();
    const sendError = jest.fn();
    const updateMessageMock = jest.fn().mockResolvedValue(undefined);
    const getMessageMock = jest.fn().mockResolvedValue({ id: 'msg_1', role: 'model', parts: [{ text: 'old' }] });
    return {
        conversationManager: {
            updateMessage: updateMessageMock,
            getMessage: getMessageMock
        },
        sendResponse,
        sendError,
        ...overrides
    } as any;
}

describe('conversation.updateMessage 处理器', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('已注册进消息处理器注册表', () => {
        const registry = createMessageHandlerRegistry();
        expect(registry.has('conversation.updateMessage')).toBe(true);
        expect(typeof registry.get('conversation.updateMessage')).toBe('function');
    });

    test('成功：预检通过后按索引原地改写 parts 并返回 { success: true }', async () => {
        const ctx = createCtx();
        await updateMessage({ conversationId: 'conv_1', messageIndex: 3, content: '修正后的 AI 回复', messageId: 'msg_1' }, 'req_1', ctx);

        expect(ctx.conversationManager.getMessage).toHaveBeenCalledWith('conv_1', 3);
        expect(ctx.conversationManager.updateMessage).toHaveBeenCalledWith('conv_1', 3, {
            parts: [{ text: '修正后的 AI 回复' }]
        });
        expect(ctx.sendResponse).toHaveBeenCalledWith('req_1', { success: true });
        expect(ctx.sendError).not.toHaveBeenCalled();
    });

    test('未传 messageId 时跳过预检直接改写', async () => {
        const ctx = createCtx();
        await updateMessage({ conversationId: 'conv_1', messageIndex: 0, content: 'no id' }, 'req_1', ctx);

        expect(ctx.conversationManager.getMessage).not.toHaveBeenCalled();
        expect(ctx.conversationManager.updateMessage).toHaveBeenCalledWith('conv_1', 0, {
            parts: [{ text: 'no id' }]
        });
        expect(ctx.sendResponse).toHaveBeenCalledWith('req_1', { success: true });
    });

    test('messageId 预检不匹配（索引漂移）→ MESSAGE_CHANGED，不调用 updateMessage', async () => {
        const ctx = createCtx({
            conversationManager: {
                updateMessage: jest.fn(),
                getMessage: jest.fn().mockResolvedValue({ id: 'other_msg', role: 'model', parts: [{ text: 'x' }] })
            }
        });
        await updateMessage({ conversationId: 'conv_1', messageIndex: 3, content: 'new', messageId: 'msg_1' }, 'req_1', ctx);

        expect(ctx.sendResponse).toHaveBeenCalledWith('req_1', {
            success: false,
            error: { code: 'MESSAGE_CHANGED', message: expect.any(String) }
        });
        expect(ctx.conversationManager.updateMessage).not.toHaveBeenCalled();
        expect(ctx.sendError).not.toHaveBeenCalled();
    });

    test('缺会话 ID → UPDATE_MESSAGE_ERROR', async () => {
        const ctx = createCtx();
        await updateMessage({ messageIndex: 0, content: 'hello' }, 'req_1', ctx);

        expect(ctx.sendError).toHaveBeenCalledWith('req_1', 'UPDATE_MESSAGE_ERROR', expect.any(String));
        expect(ctx.conversationManager.updateMessage).not.toHaveBeenCalled();
    });

    test('非法 messageIndex（负数/非整数）→ UPDATE_MESSAGE_ERROR', async () => {
        const ctx = createCtx();
        await updateMessage({ conversationId: 'conv_1', messageIndex: -1, content: 'hello' }, 'req_1', ctx);
        await updateMessage({ conversationId: 'conv_1', messageIndex: 1.5, content: 'hello' }, 'req_2', ctx);

        expect(ctx.sendError).toHaveBeenCalledWith('req_1', 'UPDATE_MESSAGE_ERROR', expect.any(String));
        expect(ctx.sendError).toHaveBeenCalledWith('req_2', 'UPDATE_MESSAGE_ERROR', expect.any(String));
        expect(ctx.conversationManager.updateMessage).not.toHaveBeenCalled();
    });

    test('空文本/非字符串 content → UPDATE_MESSAGE_ERROR', async () => {
        const ctx = createCtx();
        await updateMessage({ conversationId: 'conv_1', messageIndex: 0, content: '   ' }, 'req_1', ctx);
        await updateMessage({ conversationId: 'conv_1', messageIndex: 0 }, 'req_2', ctx);

        expect(ctx.sendError).toHaveBeenCalledWith('req_1', 'UPDATE_MESSAGE_ERROR', expect.any(String));
        expect(ctx.sendError).toHaveBeenCalledWith('req_2', 'UPDATE_MESSAGE_ERROR', expect.any(String));
        expect(ctx.conversationManager.updateMessage).not.toHaveBeenCalled();
    });

    test('updateMessage 抛异常 → UPDATE_MESSAGE_ERROR 且透传错误信息', async () => {
        const ctx = createCtx({
            conversationManager: {
                updateMessage: jest.fn().mockRejectedValue(new Error('storage boom')),
                getMessage: jest.fn().mockResolvedValue({ id: 'msg_1' })
            }
        });
        await updateMessage({ conversationId: 'conv_1', messageIndex: 0, content: 'hello', messageId: 'msg_1' }, 'req_1', ctx);

        expect(ctx.sendError).toHaveBeenCalledWith('req_1', 'UPDATE_MESSAGE_ERROR', 'storage boom');
        expect(ctx.sendResponse).not.toHaveBeenCalled();
    });

    test('预检 getMessage 抛异常 → UPDATE_MESSAGE_ERROR（不触达 updateMessage）', async () => {
        const ctx = createCtx({
            conversationManager: {
                updateMessage: jest.fn(),
                getMessage: jest.fn().mockRejectedValue(new Error('read boom'))
            }
        });
        await updateMessage({ conversationId: 'conv_1', messageIndex: 0, content: 'hello', messageId: 'msg_1' }, 'req_1', ctx);

        expect(ctx.sendError).toHaveBeenCalledWith('req_1', 'UPDATE_MESSAGE_ERROR', 'read boom');
        expect(ctx.conversationManager.updateMessage).not.toHaveBeenCalled();
    });
});
