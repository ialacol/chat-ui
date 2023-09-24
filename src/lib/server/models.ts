import { HF_ACCESS_TOKEN, OPENAI_API_KEY, MODELS, OLD_MODELS } from "$env/static/private";
import type { ChatTemplateInput, WebSearchQueryTemplateInput } from "$lib/types/Template";
import { compileTemplate } from "$lib/utils/template";
import { z } from "zod";

type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>;

const openAICompatibleEndpoint = z.object({
	host: z.literal("openai-compatible"),
	baseURL: z.string().url().default("https://api.openai.com/v1"),
	apiKey: z.string().optional().default(OPENAI_API_KEY),
	type: z
		.union([z.literal("completions"), z.literal("chat_completions")])
		.default("chat_completions"),
});

const sagemakerEndpoint = z.object({
	host: z.literal("sagemaker"),
	url: z.string().url(),
	accessKey: z.string().min(1),
	secretKey: z.string().min(1),
	sessionToken: z.string().optional(),
});

const tgiEndpoint = z.object({
	host: z.union([z.literal("tgi"), z.undefined()]),
	url: z.string().url(),
	authorization: z.string().min(1).default(`Bearer ${HF_ACCESS_TOKEN}`),
});

const commonEndpoint = z.object({
	weight: z.number().int().positive().default(1),
});

const endpoint = z.lazy(() =>
	z.union([
		openAICompatibleEndpoint.merge(commonEndpoint),
		sagemakerEndpoint.merge(commonEndpoint),
		tgiEndpoint.merge(commonEndpoint),
	])
);

const combinedEndpoint = endpoint.transform((data) => {
	if (data.host === "tgi" || data.host === undefined) {
		return tgiEndpoint.merge(commonEndpoint).parse(data);
	} else if (data.host === "sagemaker") {
		return sagemakerEndpoint.merge(commonEndpoint).parse(data);
	} else if (data.host === "openai-compatible") {
		return openAICompatibleEndpoint.merge(commonEndpoint).parse(data);
	} else {
		throw new Error(`Invalid host: ${data.host}`);
	}
});

const modelsRaw = z
	.array(
		z.object({
			/** Used as an identifier in DB */
			id: z.string().optional(),
			/** Used to link to the model page, and for inference */
			name: z.string().min(1),
			/** If true, use this model for to summarize conversation or searchQuery */
			defaultModel: z.boolean().default(false),
			displayName: z.string().min(1).optional(),
			description: z.string().min(1).optional(),
			websiteUrl: z.string().url().optional(),
			modelUrl: z.string().url().optional(),
			datasetName: z.string().min(1).optional(),
			datasetUrl: z.string().url().optional(),
			userMessageToken: z.string().default(""),
			userMessageEndToken: z.string().default(""),
			assistantMessageToken: z.string().default(""),
			assistantMessageEndToken: z.string().default(""),
			messageEndToken: z.string().default(""),
			preprompt: z.string().default(""),
			prepromptUrl: z.string().url().optional(),
			chatPromptTemplate: z
				.string()
				.default(
					"{{preprompt}}" +
						"{{#each messages}}" +
						"{{#ifUser}}{{@root.userMessageToken}}{{content}}{{@root.userMessageEndToken}}{{/ifUser}}" +
						"{{#ifAssistant}}{{@root.assistantMessageToken}}{{content}}{{@root.assistantMessageEndToken}}{{/ifAssistant}}" +
						"{{/each}}" +
						"{{assistantMessageToken}}"
				),
			webSearchQueryPromptTemplate: z
				.string()
				.default(
					"{{userMessageToken}}" +
						'My question is: "{{message.content}}". ' +
						"Based on the conversation history (my previous questions are: {{previousMessages}}), give me an appropriate query to answer my question for google search. You should not say more than query. You should not say any words except the query. For the context, today is {{currentDate}}" +
						"{{userMessageEndToken}}" +
						"{{assistantMessageToken}}"
				),
			promptExamples: z
				.array(
					z.object({
						title: z.string().min(1),
						prompt: z.string().min(1),
					})
				)
				.optional(),
			endpoints: z.array(combinedEndpoint).optional(),
			parameters: z
				.object({
					temperature: z.number().min(0).max(1),
					truncate: z.number().int().positive(),
					max_new_tokens: z.number().int().positive(),
					stop: z.array(z.string()).optional(),
					top_p: z.number().positive(),
					top_k: z.number().positive(),
					repetition_penalty: z.number().positive(),
				})
				.passthrough()
				.optional(),
		})
	)
	.parse(JSON.parse(MODELS));

export const models = await Promise.all(
	modelsRaw.map(async (m) => ({
		...m,
		userMessageEndToken: m?.userMessageEndToken || m?.messageEndToken,
		assistantMessageEndToken: m?.assistantMessageEndToken || m?.messageEndToken,
		chatPromptRender: compileTemplate<ChatTemplateInput>(m.chatPromptTemplate, m),
		webSearchQueryPromptRender: compileTemplate<WebSearchQueryTemplateInput>(
			m.webSearchQueryPromptTemplate,
			m
		),
		id: m.id || m.name,
		displayName: m.displayName || m.name,
		preprompt: m.prepromptUrl ? await fetch(m.prepromptUrl).then((r) => r.text()) : m.preprompt,
	}))
);

// Models that have been deprecated
export const oldModels = OLD_MODELS
	? z
			.array(
				z.object({
					id: z.string().optional(),
					name: z.string().min(1),
					displayName: z.string().min(1).optional(),
				})
			)
			.parse(JSON.parse(OLD_MODELS))
			.map((m) => ({ ...m, id: m.id || m.name, displayName: m.displayName || m.name }))
	: [];

export type BackendModel = Optional<(typeof models)[0], "preprompt">;
export type Endpoint = z.infer<typeof endpoint>;

export const getDefaultModel = () => {
	const _defaultModel = models.find((model) => model.defaultModel === true);
	if (!_defaultModel) {
		throw new Error(
			"Specify at least one default model in MODELS env variable with defaultModel: true"
		);
	}
	return _defaultModel;
};

export const validateModel = (_models: BackendModel[]) => {
	// Zod enum function requires 2 parameters
	return z.enum([_models[0].id, ..._models.slice(1).map((m) => m.id)]);
};
