import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Block provider execution, not request-hook exceptions, which Pi only logs. */
export default function workGuard(pi: ExtensionAPI) {
  const guarded = new WeakSet<object>();
  const enforce = (_event: unknown, ctx: ExtensionContext) => {
    const registry = ctx.modelRegistry;
    const models = [...registry.getAll(), ...registry.getModelsOfType("image"), ...registry.getModelsOfType("classifier")];
    for (const id of new Set(models.map((model) => model.provider))) {
      const provider = registry.getProvider(id);
      if (!provider || guarded.has(provider)) continue;
      const deny = () => { throw new Error(`piw only permits direct Anthropic models. Blocked provider: ${id}`); };
      if (id === "anthropic") {
        const checkEndpoint = (model: { api: string; baseUrl: string }) => {
          const url = new URL(model.baseUrl);
          if (model.api !== "anthropic-messages" || url.origin !== "https://api.anthropic.com" ||
              url.username || url.password || url.search || url.hash || !["/", "/v1", "/v1/"].includes(url.pathname)) {
            throw new Error("piw requires the direct https://api.anthropic.com Anthropic Messages endpoint.");
          }
        };
        registry.registerProvider({
          ...provider,
          stream: (model, context, options) => { checkEndpoint(model); return provider.stream(model, context, options); },
          streamSimple: (model, context, options) => { checkEndpoint(model); return provider.streamSimple(model, context, options); },
        });
      } else registry.registerProvider({
        ...provider,
        auth: { apiKey: { name: "Blocked in piw", check: async () => undefined, resolve: async () => deny() } },
        refreshModels: undefined,
        stream: deny,
        streamSimple: deny,
        fetchDeferred: deny,
        cancelDeferred: async () => deny(),
        generateImages: async () => deny(),
        classify: async () => deny(),
      });
      const replacement = registry.getProvider(id);
      if (replacement) guarded.add(replacement);
    }
    ctx.ui.setStatus("work-profile", "work · Anthropic only");
  };
  pi.on("session_start", enforce);
  pi.on("model_select", enforce);
  pi.on("before_agent_start", enforce);
  pi.on("session_before_compact", enforce);
}
