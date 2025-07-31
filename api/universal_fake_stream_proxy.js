/**
 * Universal Fake Streaming Proxy
 *
 * Author: codeboy
 * Date: 2025-4-22
 *
 * Description:
 * This script implements a fake streaming proxy compatible with Deno,
 * Cloudflare Workers/Pages, Vercel Edge Functions, and local Node.js.
 * It bridges the gap between clients expecting streaming responses (SSE)
 * and backend APIs that only provide non-streaming (full JSON) responses,
 * preventing client-side timeouts (e.g., 504 errors) by sending keep-alive
 * messages and chunking the final response.
 */
 
// --- Helper Functions (Core Logic) ---

/**
 * Simple passthrough proxy for non-streaming requests or other methods
 */
async function handlePassthrough(request, targetUrl, requestBodyContent = null) {
    try {
      // Copy original headers, excluding potential problematic ones like 'content-length' if body changes
      const headers = new Headers(request.headers);
      headers.delete('content-length'); // Let fetch recalculate if needed
      headers.delete('host'); // Avoid sending the proxy's host header

      console.log(`[Passthrough] ${request.method} ${targetUrl}`);

      const backendRequest = new Request(targetUrl, {
        method: request.method,
        headers: headers,
        redirect: 'manual', // Handle redirects based on backend response if needed
        body: (request.method !== 'GET' && request.method !== 'HEAD') ? requestBodyContent : null,
        // Consider adding duplex: 'half' for streaming request bodies if needed in the future
      });

      const backendResponse = await fetch(backendRequest);

      // Filter hop-by-hop headers before sending back to client
      const responseHeaders = new Headers(backendResponse.headers);
      responseHeaders.delete('content-encoding'); // Let client handle decompression
      responseHeaders.delete('transfer-encoding');
      responseHeaders.delete('connection');

      return new Response(backendResponse.body, {
        status: backendResponse.status,
        statusText: backendResponse.statusText,
        headers: responseHeaders
      });
    } catch (error) {
      console.error(`[Passthrough Error] ${request.method} ${targetUrl}:`, error);
      return new Response(`Proxy error: ${error.message}`, { status: 502 }); // 502 Bad Gateway
    }
}

/**
 * Handle fake streaming for chat completion requests that had stream: true
 */
async function handleFakeStreaming(request, targetUrl, modifiedBody) {
    let streamController;
    const encoder = new TextEncoder();
    let keepAliveInterval = null; // Initialize interval ID tracker

    const clientStream = new ReadableStream({
        start(controller) {
            streamController = controller;
            console.log(`[Fake Stream] Started for ${targetUrl}`);
            // Set up keep-alive messages immediately after stream starts
            try {
                // Empty content keepalive, mimicking OpenAI's heartbeat
                const keepAliveMessage = encoder.encode("data: {\"id\":\"chatcmpl-keepalive\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"keepalive\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":null}]}\n\n");
                // Send initial keep-alive immediately
                streamController.enqueue(keepAliveMessage);
                // Start interval timer
                keepAliveInterval = setInterval(() => {
                    if (streamController) { // Check if controller still exists
                        try {
                            streamController.enqueue(keepAliveMessage);
                        } catch (enqueueError) {
                            console.error("[KeepAlive Error] Failed to enqueue keep-alive message:", enqueueError);
                            if (keepAliveInterval) clearInterval(keepAliveInterval); // Stop interval if enqueue fails
                            keepAliveInterval = null;
                        }
                    } else {
                       if (keepAliveInterval) clearInterval(keepAliveInterval); // Stop if controller is gone
                       keepAliveInterval = null;
                    }
                }, 2000); // 2 seconds
            } catch(err) {
                console.error("[KeepAlive Setup Error]", err);
                if(keepAliveInterval) clearInterval(keepAliveInterval);
                keepAliveInterval = null;
            }
        },
        cancel(reason) {
            console.log(`[Fake Stream] Client disconnected for ${targetUrl}. Reason:`, reason);
            if (keepAliveInterval) {
                clearInterval(keepAliveInterval);
                console.log("[KeepAlive] Interval cleared due to client disconnect.");
            }
            // TODO: Consider adding AbortController logic here to cancel the backend fetch if possible
        }
    });

    const responseHeaders = new Headers({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', // Important for SSE
        'X-Accel-Buffering': 'no' // Advise proxies like Nginx not to buffer
    });

    // Return the streaming response shell to the client immediately
    const streamingResponse = new Response(clientStream, {
        status: 200,
        headers: responseHeaders
    });

    // --- Start asynchronous backend processing ---
    (async () => {
        try {
            const headers = new Headers(request.headers);
            headers.set('Content-Type', 'application/json'); // Ensure correct content type for backend
            headers.delete('content-length'); // Let fetch recalculate
            headers.delete('host'); // Avoid sending proxy host

            console.log(`[Fake Stream] Sending non-streaming POST to backend: ${targetUrl}`);
            const backendRequest = new Request(targetUrl, {
                method: 'POST',
                headers: headers,
                body: modifiedBody
                // TODO: Add AbortController signal here if implementing cancellation
            });

            const backendResponse = await fetch(backendRequest);
            console.log(`[Fake Stream] Received backend response status: ${backendResponse.status} for ${targetUrl}`);

            // Clear the keep-alive interval *after* receiving the backend response
            if (keepAliveInterval) {
                clearInterval(keepAliveInterval);
                console.log("[KeepAlive] Interval cleared after receiving backend response.");
                keepAliveInterval = null; // Ensure it's marked as cleared
            }

            if (!backendResponse.ok) {
                const errorText = await backendResponse.text();
                console.error(`[Fake Stream Backend Error] (${backendResponse.status}) for ${targetUrl}:`, errorText);
                // Try to parse error text as JSON, fallback to raw text
                let errorDetail = errorText;
                try {
                    errorDetail = JSON.parse(errorText);
                 } catch { /* ignore json parsing error */ }

                const errorMessage = {
                    id: "error-" + Date.now().toString(36),
                    object: "error",
                    code: backendResponse.status,
                    message: errorDetail,
                    model: "error-model"
                };
                if (streamController) {
                   streamController.enqueue(encoder.encode(`data: ${JSON.stringify({error: errorMessage})}\n\n`)); // OpenAI error format often wraps in {"error": ...}
                   streamController.enqueue(encoder.encode("data: [DONE]\n\n"));
                }
                return; // Stop processing on error
            }

            const responseData = await backendResponse.json();

            let content = "";
            let model = responseData?.model || "unknown-model"; // Get model from response if available

            // Extract content robustly
            if (responseData?.choices?.[0]?.message?.content) {
                content = responseData.choices[0].message.content;
            } else if (responseData?.choices?.[0]?.text) { // Handle older/different formats
                 content = responseData.choices[0].text;
            } else if (typeof responseData === 'string') { // Handle plain string response
                 content = responseData;
            } else {
                console.warn("[Fake Stream] Could not extract standard content. Sending raw JSON.", JSON.stringify(responseData).substring(0, 200));
                content = JSON.stringify(responseData); // Fallback
            }

            const completionId = responseData?.id || ("chatcmpl-" + Date.now().toString(36) + Math.random().toString(36).substring(2, 8));

            // Chunking logic
            const chunks = [];
            if (typeof content === 'string') {
               const chunkSize = 50; // Characters per chunk (adjust for desired speed/smoothness)
               if (content.length === 0) {
                   chunks.push(""); // Ensure one empty chunk for empty content
               } else {
                   for (let i = 0; i < content.length; i += chunkSize) {
                       chunks.push(content.substring(i, i + chunkSize));
                   }
               }
            } else {
               chunks.push(JSON.stringify(content)); // Send non-string content as a single chunk
            }

            console.log(`[Fake Stream] Processing ${chunks.length} chunks for client ${targetUrl}`);

            // Stream content chunks
            for (let i = 0; i < chunks.length; i++) {
                if (!streamController) break; // Stop if client disconnected
                const chunk = chunks[i];
                const chunkData = {
                    id: completionId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{
                        delta: { content: chunk },
                        index: 0,
                        finish_reason: (i === chunks.length - 1) ? "stop" : null // Set finish_reason only on the last content chunk
                    }]
                };
                streamController.enqueue(encoder.encode(`data: ${JSON.stringify(chunkData)}\n\n`));
                // Optional delay - adjust for smoother perceived streaming
                if (i < chunks.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 30)); // 30ms delay
                }
            }

            // Send the final [DONE] marker if the loop completed
            if (streamController) {
               streamController.enqueue(encoder.encode("data: [DONE]\n\n"));
               console.log(`[Fake Stream] Finished streaming and sent [DONE] for ${targetUrl}`);
            }

        } catch (error) {
            console.error(`[Fake Stream] Error during backend processing for ${targetUrl}:`, error);
            // Clean up interval if it's still running due to an error
            if (keepAliveInterval) {
                clearInterval(keepAliveInterval);
                console.log("[KeepAlive] Interval cleared due to processing error.");
            }
            // Try sending an error to the client if the stream is still open
            if (streamController) {
                try {
                    const errorMsg = { error: { message: `Internal proxy error: ${error.message}`, code: 500 } };
                    streamController.enqueue(encoder.encode(`data: ${JSON.stringify(errorMsg)}\n\n`));
                    streamController.enqueue(encoder.encode("data: [DONE]\n\n"));
                } catch (finalError) {
                    console.error("[Fake Stream] Failed to send error message to client:", finalError);
                }
            }
        } finally {
            // Ensure the stream is closed in all cases (success or error)
            if (streamController) {
                try {
                    streamController.close();
                    console.log(`[Fake Stream] Stream controller closed for ${targetUrl}.`);
                } catch (closeError) {
                    // Might happen if already closed or errored
                    console.warn(`[Fake Stream] Minor error closing stream controller for ${targetUrl}:`, closeError.message);
                }
            }
        }
    })(); // End of async processing function

    return streamingResponse; // Return the response shell immediately
}


// --- Universal Handler ---

async function handler(request) {
    // --- New, more robust URL parsing logic ---
    const requestUrl = new URL(request.url);
    const address = requestUrl.searchParams.get('address');

    // Basic validation for the address parameter
    if (!address) {
        if (requestUrl.pathname === '/' && !requestUrl.search) {
           return new Response("Universal Fake Streaming Proxy is running.", { status: 200, headers: { 'Content-Type': 'text/plain'} });
        }
        return new Response('Missing target address parameter (`?address=...`)', { status: 400 });
    }

    // The rest of the path is now extracted from the pathname, not from a '$' delimited string
    // Assumes the Vercel function is at the root of the api folder e.g. /api/proxy
    // We need to strip the function's own path from the start of the pathname.
    // Example: request pathname is /api/proxy/v1/chat, function file is /api/proxy.js
    // We want the extraPath to be /v1/chat
    // A simple way is to expect a known separator. Let's stick to '$' but use it in the path.
    // New URL Structure: .../api/proxy/$/<actual_path>?address=<base_api>
    
    const dollarIndex = requestUrl.pathname.indexOf('$');
    let extraPath = '';
    if (dollarIndex !== -1) {
        extraPath = requestUrl.pathname.substring(dollarIndex + 1);
    }
    
    let targetUrl;
    try {
        // Validate and create the base URL from the address parameter
        const base = new URL(address);
        // Combine it with the extra path
        targetUrl = new URL(extraPath, base).href;
    } catch (_) {
       return new Response('Invalid target address format provided in `?address=` parameter.', { status: 400 });
    }
    
    // --- End of new parsing logic ---

    // Determine if fake streaming logic should be applied
    const isPotentialChatCompletion = request.method === 'POST' &&
                                      (targetUrl.includes('/chat/completions'));

    let wasOriginallyStreaming = false;
    let modifiedBodyContent = null;
    let requestHadBody = false;

    if (request.body && (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH')) {
        requestHadBody = true;
        try {
            const requestClone = request.clone(); // Clone to read body non-destructively
            const bodyText = await requestClone.text();

            if (bodyText && isPotentialChatCompletion) {
                try {
                   const parsedBody = JSON.parse(bodyText);
                   wasOriginallyStreaming = parsedBody.stream === true;

                   if (wasOriginallyStreaming) {
                       console.log(`[Handler] Detected stream=true for ${targetUrl}. Modifying request.`);
                       parsedBody.stream = false;
                       modifiedBodyContent = JSON.stringify(parsedBody);
                   } else {
                       console.log(`[Handler] Detected stream=false/absent for ${targetUrl}. Passing through body.`);
                       modifiedBodyContent = bodyText;
                   }
                 } catch (jsonError) {
                      console.warn(`[Handler] Request body for POST ${targetUrl} is not valid JSON. Passing through raw body.`, jsonError.message);
                      modifiedBodyContent = bodyText;
                      wasOriginallyStreaming = false;
                 }
            } else if (bodyText) {
                 modifiedBodyContent = bodyText;
            }

        } catch (bodyError) {
            console.error(`[Handler] Error reading request body for ${targetUrl}:`, bodyError);
            return new Response(`Error reading request body: ${bodyError.message}`, { status: 400 });
        }
    }

    // Route to fake streaming or passthrough
    if (isPotentialChatCompletion && wasOriginallyStreaming) {
        return handleFakeStreaming(request, targetUrl, modifiedBodyContent);
    } else {
        const bodyForPassthrough = modifiedBodyContent !== null ? modifiedBodyContent : (requestHadBody ? request.body : null);
        return handlePassthrough(request, targetUrl, bodyForPassthrough);
    }
}

// --- Platform Compatibility Boilerplate ---

(async () => {
    const PORT = 8000; // Default port

    // Deno Runtime
    if (typeof Deno !== 'undefined' && Deno.serve) {
        const denoPort = parseInt(Deno.env?.get("PORT") || `${PORT}`, 10);
        console.log(`Deno runtime detected. Listening on http://localhost:${denoPort}`);
        return Deno.serve({ port: denoPort, hostname: "0.0.0.0" }, handler); // Listen on all interfaces
    }

    // Vercel Edge Runtime (Does nothing here, relies on exports)
    if (typeof EdgeRuntime !== 'undefined') {
        console.log("Vercel Edge Runtime detected. Exports will be used.");
        return; // Vercel uses the exported handlers directly
    }

    // Cloudflare Workers (Module Worker Format - Does nothing here, relies on exports)
    // The addEventListener check might be for older Service Worker format,
    // but module format using default export is preferred.
    if (typeof addEventListener === "function" && typeof caches !== 'undefined') { // Check for 'caches' to be more specific to CFW/SW environments
        console.log("Cloudflare Worker (likely) environment detected. Exports will be used.");
        // In module workers, the export default handles requests.
        // In service workers, addEventListener would be used, but we target module format primarily.
        return;
    }

    // NodeJS Runtime (using Hono for compatibility)
    // This part requires installing '@hono/node-server': npm install @hono/node-server or yarn add @hono/node-server
    try {
        const { serve } = await eval("import('@hono/node-server')"); // Use dynamic import for Node-only dependency
        const nodePort = parseInt(process.env.PORT || `${PORT}`, 10);
        console.log(`Node.js runtime detected. Listening on http://localhost:${nodePort}`);
        serve({
            fetch: handler,
            port: nodePort,
        });
    } catch (e) {
        if (e.code === 'ERR_MODULE_NOT_FOUND') {
           console.error("Node.js runtime detected, but '@hono/node-server' not found.");
           console.error("Please install it: npm install @hono/node-server");
        } else {
           console.error("Error loading Node.js server:", e);
        }
        // Fallback or exit if Node.js runner fails
        console.warn("Could not start Node.js server. Script may only work in Deno, CF Workers, or Vercel Edge.");
    }
})();


// --- Exports for Specific Platforms ---

// Vercel Edge Function Exports
export const config = {
    runtime: 'edge',
    regions: ['hkg1'], // Example: Specify regions if needed
};
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const HEAD = handler;
export const OPTIONS = handler;
// Note: Vercel might require specific handlers per method if strict checking is enabled.
// Using the same handler for all assumes the handler logic correctly handles methods.

// Cloudflare Pages Function Export
// This format is typically used for CF Pages Functions.
export function onRequest(context) {
    // context includes request, env, params, waitUntil, next, data
    return handler(context.request); // Pass the request to the universal handler
}

// Cloudflare Workers (Module Worker) Export
// This is the standard export for CF Module Workers.
export default {
    fetch(request, env, ctx) {
        // request: The incoming Request object
        // env: Environment variables/bindings
        // ctx: Execution context (e.g., ctx.waitUntil)
        // You might need to pass 'env' or 'ctx' to your handler if it needs them
        return handler(request);
    }
}

console.log("Universal Fake Streaming Proxy script loaded.");
