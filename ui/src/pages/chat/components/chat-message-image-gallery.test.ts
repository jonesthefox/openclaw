/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { ImageLightboxGalleryController } from "../../../components/image-lightbox-gallery.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { renderMessageImages } from "./chat-message-images.ts";
import { releaseChatMediaResourceSubscriber } from "./chat-message-media.ts";
import {
  createAssistantMessage,
  createAttachmentBlock,
  createMessageGroup,
} from "./chat-message.test-support.ts";
import { renderMessageGroup } from "./chat-message.ts";

let container: HTMLDivElement;
let onRequestUpdate: () => void;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  onRequestUpdate = vi.fn();
});

afterEach(() => {
  render(nothing, container);
  releaseChatMediaResourceSubscriber(onRequestUpdate);
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderAssistantMessage(
  target: HTMLElement,
  message: unknown,
  options: Partial<Parameters<typeof renderMessageGroup>[1]>,
) {
  render(
    renderMessageGroup(createMessageGroup(message, "assistant"), {
      showReasoning: false,
      showToolCalls: false,
      assistantName: "OpenClaw",
      assistantAvatar: null,
      ...options,
    }),
    target,
  );
}

describe("message image gallery loading", () => {
  it.each(
    [
      {
        format: "MEDIA directives",
        content:
          "Introduction\n\n**Before**\nMEDIA:https://example.com/before.png\n\n**After**\nMEDIA:https://example.com/after.png\n\nClosing paragraph",
      },
      {
        format: "structured images",
        content: [
          { type: "text", text: "Introduction\n\n**Before**" },
          { type: "image", url: "https://example.com/before.png" },
          { type: "text", text: "**After**" },
          { type: "image", url: "https://example.com/after.png" },
          { type: "text", text: "Closing paragraph" },
        ],
      },
      {
        format: "mixed image blocks and document-shaped images",
        content: [
          { type: "text", text: "Introduction\n\n**Before**" },
          { type: "image", url: "https://example.com/before.png" },
          { type: "text", text: "**After**" },
          createAttachmentBlock(
            "https://example.com/after.png",
            "document",
            "after.png",
            "application/octet-stream; charset=binary",
          ),
          { type: "text", text: "Closing paragraph" },
        ],
      },
    ].flatMap(({ format, content }) =>
      [false, true].map((persisted) => ({ format, content, persisted })),
    ),
  )(
    "keeps assistant $format in order and in one image gallery (persisted: $persisted)",
    async ({ content, persisted }) => {
      const onOpenImage = vi.fn<(item: ImageLightboxItem) => void>();
      renderAssistantMessage(
        container,
        createAssistantMessage(content, {
          timestamp: 1000,
          ...(persisted
            ? {
                __openclaw: {
                  media: [
                    { path: "https://example.com/before.png", contentType: "image/png" },
                    { path: "https://example.com/after.png", contentType: "image/png" },
                  ],
                },
              }
            : {}),
        }),
        { onOpenImage },
      );

      expect(
        Array.from(
          container.querySelectorAll(".chat-text strong, .chat-message-image"),
          (element) =>
            element instanceof HTMLImageElement
              ? new URL(element.src).pathname
              : element.textContent?.replace(/\s+/g, " ").trim(),
        ),
      ).toEqual(["Before", "/before.png", "After", "/after.png"]);
      const text = container.querySelector(".chat-text")?.textContent?.trim() ?? "";
      expect(text.startsWith("Introduction")).toBe(true);
      expect(text.endsWith("Closing paragraph")).toBe(true);
      const tiles = container.querySelectorAll<HTMLButtonElement>(".chat-message-image-button");
      for (const [index, tile] of tiles.entries()) {
        tile.click();
        const opened = onOpenImage.mock.calls.at(-1)?.[0];
        expect(opened?.gallery?.index).toBe(index);
        expect(opened?.gallery?.items).toHaveLength(2);
        const gallery = expectDefined(opened?.gallery, "message image gallery");
        const neighbors = await Promise.all(gallery.items.map((load) => load()));
        expect(neighbors.map((image) => image?.src)).toEqual([
          "https://example.com/before.png",
          "https://example.com/after.png",
        ]);
        neighbors.forEach((image) => image?.release?.());
      }
    },
  );

  it("keeps duplicate attachment slots but not their persisted mirrors in the gallery", () => {
    const source = "https://example.com/repeated.png";
    const onOpenImage = vi.fn<(item: ImageLightboxItem) => void>();
    renderAssistantMessage(
      container,
      createAssistantMessage(
        [
          createAttachmentBlock(source, "document", "Repeated", "image/png"),
          createAttachmentBlock(source, "document", "Repeated", "image/png"),
        ],
        { __openclaw: { media: [{ path: source, contentType: "image/png" }] } },
      ),
      { onOpenImage },
    );
    const tiles = container.querySelectorAll<HTMLButtonElement>(".chat-message-image-button");
    expect(tiles).toHaveLength(2);
    tiles[1]?.click();
    expect(onOpenImage.mock.calls[0]?.[0].gallery).toMatchObject({
      index: 1,
      items: [expect.any(Function), expect.any(Function)],
    });
  });

  it("includes persisted images identified by an opaque download filename in the gallery", () => {
    const onOpenImage = vi.fn<(item: ImageLightboxItem) => void>();
    renderAssistantMessage(
      container,
      createAssistantMessage("", {
        __openclaw: {
          media: [
            {
              path: "https://example.com/download/first",
              fileName: "first.png",
              contentType: "application/octet-stream; charset=binary",
            },
            {
              path: "https://example.com/download/second",
              fileName: "second.avif",
              contentType: "application/octet-stream",
            },
          ],
        },
      }),
      { onOpenImage },
    );
    const tiles = container.querySelectorAll<HTMLButtonElement>(".chat-message-image-button");
    expect(tiles).toHaveLength(2);
    tiles[0]?.click();
    expect(onOpenImage.mock.calls[0]?.[0].gallery).toMatchObject({
      index: 0,
      items: [expect.any(Function), expect.any(Function)],
    });
  });

  it.each(["navigation", "tile"] as const)(
    "retries exhausted managed neighbors on %s without polling when reopened",
    async (action) => {
      vi.useFakeTimers();
      const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
      const blobPrefix = `blob:gallery-${crypto.randomUUID()}`;
      let blobIndex = 0;
      const NativeUrl = URL;
      vi.stubGlobal(
        "URL",
        class extends NativeUrl {
          static override createObjectURL = () => `${blobPrefix}-${blobIndex++}`;
          static override revokeObjectURL = vi.fn();
        },
      );
      vi.stubGlobal(
        "Image",
        class {
          src = "";
          async decode() {}
        },
      );
      const imageResponse = () => new Response("png", { headers: { "Content-Type": "image/png" } });
      const fetchFull = vi.fn(async () => new Response(null, { status: 503 }));
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => (url === source ? fetchFull() : imageResponse())),
      );
      const controller = new ImageLightboxGalleryController(vi.fn());
      const onOpenImage = vi.fn((item: ImageLightboxItem) => controller.reset(item.gallery, item));
      try {
        const draw = () =>
          render(
            renderMessageImages(
              [
                { url: "data:image/png;base64,cG5n", alt: "First image" },
                { url: source, alt: "Managed neighbor" },
              ],
              { onOpenImage, onRequestUpdate },
            ),
            container,
          );
        draw();
        const firstTile = container.querySelector<HTMLButtonElement>(".chat-message-image-button")!;
        firstTile.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchFull).toHaveBeenCalledOnce();
        expect(controller.current?.title).toBe("First image");
        expect(controller.failed).toBe(false);

        // The lifecycle permits one more speculative attempt after its retry window.
        await vi.advanceTimersByTimeAsync(5_000);
        firstTile.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchFull).toHaveBeenCalledTimes(2);

        fetchFull.mockImplementation(async () => imageResponse());
        await vi.advanceTimersByTimeAsync(10_000);
        firstTile.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchFull).toHaveBeenCalledTimes(2);
        expect(controller.current?.title).toBe("First image");
        expect(controller.failed).toBe(false);

        if (action === "navigation") {
          expect(await controller.move(1)).toBe(true);
        } else {
          controller.dispose();
          draw();
          const tiles = container.querySelectorAll<HTMLButtonElement>(".chat-message-image-button");
          expect(tiles).toHaveLength(2);
          onOpenImage.mockClear();
          tiles[1]!.click();
          await vi.advanceTimersByTimeAsync(0);
          expect(onOpenImage).toHaveBeenCalledOnce();
        }
        expect(fetchFull).toHaveBeenCalledTimes(3);
        expect(controller.index).toBe(1);
        expect(controller.current).toMatchObject({
          title: "Managed neighbor",
          src: `${blobPrefix}-1`,
        });
        expect(controller.failed).toBe(false);
      } finally {
        onOpenImage.mock.calls.at(-1)?.[0].release?.();
        controller.dispose();
      }
    },
  );

  it.each([false, true])(
    "waits for local-image metadata and discards it after owner removal=%s",
    async (removeOwner) => {
      const metadata = createDeferred<Response>();
      const fetchMetadata = vi.fn(() => metadata.promise);
      vi.stubGlobal("fetch", fetchMetadata);
      const localSource = `/home/node/.openclaw/media/outbound/${crypto.randomUUID()}.png`;
      const onOpenImage = vi.fn<(item: ImageLightboxItem) => void>();
      render(
        renderMessageImages(
          [
            { url: "data:image/png;base64,cG5n", alt: "First image" },
            { url: localSource, alt: "Local neighbor" },
          ],
          { onOpenImage, onRequestUpdate, sessionKey: "main", resourceBasePath: "/openclaw" },
        ),
        container,
      );
      container.querySelector<HTMLButtonElement>(".chat-message-image-button")!.click();
      const opened = onOpenImage.mock.calls[0]?.[0];
      expect(opened?.gallery?.index).toBe(0);
      const loadNeighbor = opened?.gallery?.items[1];
      if (!loadNeighbor) {
        throw new Error("Opening the first tile did not expose its message gallery");
      }
      const settled = vi.fn();
      const neighbor = loadNeighbor().then((item) => {
        settled(item);
        return item;
      });
      // Cross a task boundary while the metadata response remains explicitly held.
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(settled).not.toHaveBeenCalled();
      expect(fetchMetadata).toHaveBeenCalledOnce();

      if (removeOwner) {
        render(nothing, container);
        releaseChatMediaResourceSubscriber(onRequestUpdate);
      }
      metadata.resolve(
        new Response(
          JSON.stringify({
            available: true,
            mediaTicket: "gallery-neighbor-ticket",
            mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
      const result = await neighbor;
      if (removeOwner) {
        expect(result).toBeNull();
      } else {
        expect(result?.title).toBe("Local neighbor");
        const url = new URL(result!.src, window.location.href);
        expect(url.pathname).toBe("/openclaw/__openclaw__/assistant-media");
        expect(url.searchParams.get("source")).toBe(localSource);
        expect(url.searchParams.get("mediaTicket")).toBe("gallery-neighbor-ticket");
        expect(url.searchParams.get("sessionKey")).toBe("main");
      }
    },
  );
});
