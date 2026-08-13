/**
 * 包含两组 StreamChunkProcessor 回归测试：
 *
 * 1. 视图缺失场景回归测试（桌面 H6 中止语义）：
 *    - 正常路径（视图存在）：chunk/终结事件按 streamChunk 格式送达，顺序不变；
 *    - H6 中止语义：视图缺失（面板关闭/重载）时 chunk 与终结事件一律不可投递，
 *      返回 false；消费方经 isViewUnreachable() 中止后端生成（暂存补发机制已移除，
 *      前端会话状态由后端会话数据重建）；
 *    - 无 view 时 flush() 清空 messageBuffer，防止缓冲滞留内存；
 *    - viewEverReachable 语义：从未有视图的流（后台任务）isViewUnreachable() 恒 false，
 *      保持既有继续消费语义。
 * 2. processChunk 增量类型判定回归测试：
 *    - 对象增量（主路径，回归保护）
 *    - 字符串/空串增量（兼容路径，修复 16 的初衷：空串合法）
 *    - 未知类型（应丢弃）
 */

import { StreamChunkProcessor } from '../../../webview/stream/StreamChunkProcessor';
import { PUSH_MESSAGE_NAMES } from '../../../shared/protocol';

jest.mock('../../modules/activity', () => ({
    markAiActive: jest.fn(),
}));

interface ViewRef {
  current: { webview: { postMessage: jest.Mock } } | undefined;
}

function createProcessor(): { processor: StreamChunkProcessor; postMessage: jest.Mock } {
    const postMessage = jest.fn().mockReturnValue(true);
    const processor = new StreamChunkProcessor(
        () => ({ webview: { postMessage } as any }),
        'conv-1',
        'stream-1'
    );
    return { processor, postMessage };
}

function lastPosted(postMessage: jest.Mock): any {
    expect(postMessage).toHaveBeenCalled();
    const calls = postMessage.mock.calls;
    return calls[calls.length - 1][0];
}

describe('StreamChunkProcessor - 视图缺失时 H6 中止语义', () => {
  const postMessage = jest.fn();
  const viewRef: ViewRef = { current: undefined };

  const makeProcessor = (conversationId = 'conv-1', streamId = 'stream-1', allowHeadlessConsume = false): StreamChunkProcessor =>
    new StreamChunkProcessor(() => viewRef.current as any, conversationId, streamId, allowHeadlessConsume);

  beforeEach(() => {
    postMessage.mockClear();
    viewRef.current = { webview: { postMessage } };
  });

  it('正常路径：chunk 与 complete 依次以 streamChunk 格式送达，顺序不变', () => {
    const processor = makeProcessor();
    processor.processChunk({ chunk: 'hello' });
    processor.processChunk({ content: 'hello', checkpoints: [{ id: 'cp-1' }] });

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[0][0].type).toBe('streamChunk');
    expect(postMessage.mock.calls[0][0].data).toMatchObject({
      conversationId: 'conv-1',
      streamId: 'stream-1',
      type: 'chunk',
      chunk: 'hello'
    });
    expect(postMessage.mock.calls[1][0].type).toBe('streamChunk');
    expect(postMessage.mock.calls[1][0].data).toMatchObject({
      conversationId: 'conv-1',
      streamId: 'stream-1',
      type: 'complete',
      content: 'hello',
      checkpoints: [{ id: 'cp-1' }]
    });
  });

  it('视图缺失时 complete 不可投递：返回 false 且不暂存，视图恢复后不再补发（H6）', () => {
    const processor = makeProcessor();
    // 先让视图可达（viewEverReachable 置位），再模拟面板关闭
    expect(processor.processChunk({ chunk: 'warm' })).toBe(false);
    viewRef.current = undefined;

    const result = processor.processChunk({ content: 'done', checkpoints: [{ id: 'cp-1' }] });
    expect(result).toBe(false);
    // 视图缺失期间不得发送任何消息
    expect(postMessage).toHaveBeenCalledTimes(1);
    // 视图从可达变为不可达：消费方据此中止后端生成
    expect(processor.isViewUnreachable()).toBe(true);

    // 视图恢复后：无补发（旧流已由 H6 中止，前端状态从后端会话数据重建）
    viewRef.current = { webview: { postMessage } };
    processor.flush();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(processor.isViewUnreachable()).toBe(false);
  });

  it('视图缺失时 cancelled 同样不可投递：缓冲中的普通 chunk 被清空，无补发', () => {
    const processor = makeProcessor();
    // 第一个 chunk 立即 flush；第二个 chunk 进入节流缓冲（50ms 内不立即发送）
    processor.processChunk({ chunk: 'first' });
    processor.processChunk({ chunk: 'second' });
    expect(postMessage).toHaveBeenCalledTimes(1);

    // 视图消失后收到 cancelled：不可投递返回 false；此时 consumeStream 已判定
    // isViewUnreachable 中止流，随后的 flush 在视图缺失状态下清空缓冲（'second' 丢弃）
    viewRef.current = undefined;
    expect(processor.processChunk({ cancelled: true, content: 'partial' })).toBe(false);
    expect(postMessage).toHaveBeenCalledTimes(1);
    processor.flush();
    expect(postMessage).toHaveBeenCalledTimes(1);

    // 视图恢复：无补发，被清空的 chunk 也不投递
    viewRef.current = { webview: { postMessage } };
    processor.flush();
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('视图缺失时 error 终结事件返回 false（与普通 chunk 一致，经 isViewUnreachable 区分）', () => {
    const processor = makeProcessor();
    // 先让视图可达（viewEverReachable 置位），再模拟面板关闭
    expect(processor.processChunk({ chunk: 'warm' })).toBe(false);
    viewRef.current = undefined;

    const result = processor.processChunk({ error: { code: 'API_ERROR', message: 'boom' } });
    expect(result).toBe(false);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(processor.isViewUnreachable()).toBe(true);
  });

  it('视图缺失时非终结 chunk 直接丢弃，无暂存补发路径', () => {
    const processor = makeProcessor();
    viewRef.current = undefined;

    expect(processor.processChunk({ chunk: 'incremental' })).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();

    // 终结事件同样不可投递（H6）
    expect(processor.processChunk({ content: 'final' })).toBe(false);
    viewRef.current = { webview: { postMessage } };
    processor.flush();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('无 view 时 flush() 清空 messageBuffer 防止滞留，视图恢复后不再补发旧缓冲', async () => {
    const processor = makeProcessor();
    // 第一个 chunk 立即 flush；第二个 chunk 进入节流缓冲
    processor.processChunk({ chunk: 'a' });
    processor.processChunk({ chunk: 'b' });
    expect(postMessage).toHaveBeenCalledTimes(1);

    // 视图缺失时 flush：缓冲被清空，不发送也不滞留
    viewRef.current = undefined;
    processor.flush();
    expect(postMessage).toHaveBeenCalledTimes(1);

    // 视图恢复后再 flush：缓冲已空，无多余消息
    viewRef.current = { webview: { postMessage } };
    processor.flush();
    expect(postMessage).toHaveBeenCalledTimes(1);

    // 等待超过节流窗口（50ms），新 chunk 应正常送达（而非恢复旧缓冲）
    await new Promise(resolve => setTimeout(resolve, 80));
    processor.processChunk({ chunk: 'c' });
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[1][0].data.type).toBe('chunk');
    expect(postMessage.mock.calls[1][0].data.chunk).toBe('c');
  });

  it('sendError 在视图缺失时静默丢弃（H6 中止路径），视图恢复后不补发', () => {
    const processor = makeProcessor();
    viewRef.current = undefined;

    processor.sendError('REROLL_ERROR', 'failed', 'API_ERROR');
    expect(postMessage).not.toHaveBeenCalled();

    viewRef.current = { webview: { postMessage } };
    processor.flush();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('从未有视图的流（后台任务，allowHeadlessConsume=true）：isViewUnreachable() 恒 false，保持继续消费语义', () => {
    // 后台任务路径经 ChatHandlers 以 allowHeadlessConsume=true 构造（!ctx.postMessage），
    // 无视图时仍继续消费后端流；默认（false）下流启动即无视图判不可达
    const processor = makeProcessor('conv-1', 'stream-1', true);
    // viewRef.current 初始为 undefined（见 beforeEach 前的声明），
    // 本测试不设置视图，模拟「流启动时视图已不可达」的后台任务场景
    viewRef.current = undefined;

    expect(processor.processChunk({ chunk: 'x' })).toBe(false);
    // viewEverReachable 未置位 → 不中止
    expect(processor.isViewUnreachable()).toBe(false);
  });

  it('正常路径：cancelled 先发送缓冲的 chunk 再发送终结事件（既有语义不变）', () => {
    const processor = makeProcessor();
    processor.processChunk({ chunk: 'first' });
    processor.processChunk({ chunk: 'second' });
    expect(postMessage).toHaveBeenCalledTimes(1);

    processor.processChunk({ cancelled: true, content: 'partial' });
    expect(postMessage).toHaveBeenCalledTimes(3);
    expect(postMessage.mock.calls[1][0].data).toMatchObject({ type: 'chunk', chunk: 'second' });
    expect(postMessage.mock.calls[2][0].data).toMatchObject({ type: 'cancelled', content: 'partial' });
  });
});

describe('StreamChunkProcessor.processChunk 增量类型判定', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    test('对象增量 { chunk: { delta } } 应发送（回归：2c93ad4e 曾把对象增量丢进 unknown）', () => {
        const { processor, postMessage } = createProcessor();
        const isError = processor.processChunk({
            conversationId: 'conv-1',
            streamId: 'stream-1',
            type: 'chunk',
            chunk: { delta: [{ text: 'hello' }], done: false },
            createdAt: 1,
        });
        expect(isError).toBe(false);
        const msg = lastPosted(postMessage);
        expect(msg.type).toBe(PUSH_MESSAGE_NAMES.streamChunk);
        expect(msg.data.type).toBe('chunk');
        expect(msg.data.conversationId).toBe('conv-1');
        expect(msg.data.streamId).toBe('stream-1');
        // 对象原样透传（前端 handleChunkType 读 chunk.chunk.delta）
        expect(msg.data.chunk).toEqual({ delta: [{ text: 'hello' }], done: false });
    });

    test('空数组增量 { chunk: { delta: [] } } 应发送', () => {
        const { processor, postMessage } = createProcessor();
        processor.processChunk({
            conversationId: 'conv-1',
            streamId: 'stream-1',
            type: 'chunk',
            chunk: { delta: [], done: false },
            createdAt: 1,
        });
        expect(postMessage).toHaveBeenCalled();
    });

    test('字符串增量 { chunk: "text" } 应发送（兼容路径）', () => {
        const { processor, postMessage } = createProcessor();
        processor.processChunk({
            conversationId: 'conv-1',
            streamId: 'stream-1',
            type: 'chunk',
            chunk: 'hi',
            createdAt: 1,
        });
        const msg = lastPosted(postMessage);
        expect(msg.data.type).toBe('chunk');
        expect(msg.data.chunk).toBe('hi');
    });

    test('空字符串增量 { chunk: "" } 应发送（修复 16 初衷：空串合法，不落 unknown）', () => {
        const { processor, postMessage } = createProcessor();
        processor.processChunk({
            conversationId: 'conv-1',
            streamId: 'stream-1',
            type: 'chunk',
            chunk: '',
            createdAt: 1,
        });
        const msg = lastPosted(postMessage);
        expect(msg.data.type).toBe('chunk');
        expect(msg.data.chunk).toBe('');
    });

    test('complete（content 对象）走 complete 分支并立即发送', () => {
        const { processor, postMessage } = createProcessor();
        processor.processChunk({
            conversationId: 'conv-1',
            streamId: 'stream-1',
            type: 'complete',
            content: { id: 'm1', parts: [{ text: 'final' }] },
            createdAt: 1,
        });
        const msg = lastPosted(postMessage);
        expect(msg.data.type).toBe('complete');
        expect(msg.data.content).toEqual({ id: 'm1', parts: [{ text: 'final' }] });
    });

    test('未知类型不发送、不抛错', () => {
        const { processor, postMessage } = createProcessor();
        const isError = processor.processChunk({ foo: 'bar' });
        expect(isError).toBe(false);
        expect(postMessage).not.toHaveBeenCalled();
    });

    test('视图不可达时不发送并返回 false（isViewUnreachable 命中）', () => {
        const processor = new StreamChunkProcessor(() => undefined, 'conv-1', 'stream-1');
        const isError = processor.processChunk({
            chunk: { delta: [{ text: 'a' }], done: false },
        });
        expect(isError).toBe(false);
        expect(processor.isViewUnreachable()).toBe(true);
    });
});
