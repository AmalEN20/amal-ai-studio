import type { BusinessInput, GeneratedSite } from "@/lib/types";
import { generateOpenAIText, openAIConfigured } from "@/lib/openai";

export async function generateSite(input: BusinessInput): Promise<{
  site: GeneratedSite;
  provider: "openai" | "fallback";
  warning?: string;
}> {
  if (!openAIConfigured()) {
    return {
      site: buildFallbackSite(input),
      provider: "fallback",
      warning: "OPENAI_API_KEY не настроен — использован локальный генератор.",
    };
  }

  try {
    const text = await generateOpenAIText({
      feature: "site_generation",
      instructions: SYSTEM_PROMPT,
      prompt: JSON.stringify(input),
    });
    const parsed = JSON.parse(stripCodeFence(text)) as Partial<GeneratedSite>;
    return { site: normalizeGeneratedSite(parsed, input), provider: "openai" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return {
      site: buildFallbackSite(input),
      provider: "fallback",
      warning: `AI временно недоступен (${message}); использован локальный генератор.`,
    };
  }
}

function stripCodeFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function normalizeGeneratedSite(
  value: Partial<GeneratedSite>,
  input: BusinessInput,
): GeneratedSite {
  const fallback = buildFallbackSite(input);
  return {
    research: {
      summary: clean(value.research?.summary, fallback.research.summary),
      differentiators: list(
        value.research?.differentiators,
        fallback.research.differentiators,
      ),
      customerNeeds: list(
        value.research?.customerNeeds,
        fallback.research.customerNeeds,
      ),
    },
    strategy: {
      positioning: clean(
        value.strategy?.positioning,
        fallback.strategy.positioning,
      ),
      primaryGoal: clean(
        value.strategy?.primaryGoal,
        fallback.strategy.primaryGoal,
      ),
      sections: list(value.strategy?.sections, fallback.strategy.sections),
    },
    copy: {
      eyebrow: clean(value.copy?.eyebrow, fallback.copy.eyebrow),
      headline: clean(value.copy?.headline, fallback.copy.headline),
      subheadline: clean(value.copy?.subheadline, fallback.copy.subheadline),
      primaryCta: clean(value.copy?.primaryCta, fallback.copy.primaryCta),
      secondaryCta: clean(value.copy?.secondaryCta, fallback.copy.secondaryCta),
      services:
        Array.isArray(value.copy?.services) && value.copy.services.length >= 3
          ? value.copy.services.slice(0, 3).map((service, index) => ({
              title: clean(service?.title, fallback.copy.services[index].title),
              description: clean(
                service?.description,
                fallback.copy.services[index].description,
              ),
            }))
          : fallback.copy.services,
      proofLabel: clean(value.copy?.proofLabel, fallback.copy.proofLabel),
      testimonial: {
        quote: clean(
          value.copy?.testimonial?.quote,
          fallback.copy.testimonial.quote,
        ),
        name: clean(
          value.copy?.testimonial?.name,
          fallback.copy.testimonial.name,
        ),
        role: clean(
          value.copy?.testimonial?.role,
          fallback.copy.testimonial.role,
        ),
      },
      finalCtaTitle: clean(
        value.copy?.finalCtaTitle,
        fallback.copy.finalCtaTitle,
      ),
      finalCtaBody: clean(
        value.copy?.finalCtaBody,
        fallback.copy.finalCtaBody,
      ),
    },
    design: {
      themeName: clean(value.design?.themeName, fallback.design.themeName),
      background: color(value.design?.background, fallback.design.background),
      surface: color(value.design?.surface, fallback.design.surface),
      text: color(value.design?.text, fallback.design.text),
      muted: color(value.design?.muted, fallback.design.muted),
      accent: color(value.design?.accent, fallback.design.accent),
      accentSoft: color(value.design?.accentSoft, fallback.design.accentSoft),
    },
    stats:
      Array.isArray(value.stats) && value.stats.length >= 3
        ? value.stats.slice(0, 3).map((stat, index) => ({
            value: clean(stat?.value, fallback.stats[index].value),
            label: clean(stat?.label, fallback.stats[index].label),
          }))
        : fallback.stats,
  };
}

function clean(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 600)
    : fallback;
}

function list(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const cleaned = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, 160))
    .filter(Boolean)
    .slice(0, 6);
  return cleaned.length ? cleaned : fallback;
}

function color(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? value
    : fallback;
}

function buildFallbackSite(input: BusinessInput): GeneratedSite {
  const industry = input.industry || "бизнес";
  const location = input.location || "вашем городе";
  const premium = input.tone === "bold";
  const headline = premium
    ? `${input.name}: новый стандарт в сфере ${industry}`
    : `${input.name} — когда качество ощущается с первого контакта`;

  return {
    research: {
      summary: `${input.name} работает в сфере ${industry} и помогает аудитории «${input.audience}» получить понятный, качественный результат.`,
      differentiators: [
        "Персональный подход без лишней бюрократии",
        `Локальная экспертиза: ${location}`,
        "Прозрачный путь от запроса до результата",
      ],
      customerNeeds: [
        "Быстро понять ценность предложения",
        "Увидеть подтверждение качества",
        "Легко сделать следующий шаг",
      ],
    },
    strategy: {
      positioning: `${input.offer} — в премиальной подаче, где доверие строится через ясность и детали.`,
      primaryGoal: "Получить квалифицированную заявку или запись на консультацию.",
      sections: ["Hero", "Services", "Proof", "Final CTA"],
    },
    copy: {
      eyebrow: `${industry} · ${location}`,
      headline,
      subheadline:
        input.description ||
        `Продуманный сервис для тех, кто ценит сильный результат, спокойный процесс и внимание к каждой детали.`,
      primaryCta: "Обсудить задачу",
      secondaryCta: "Посмотреть подход",
      services: [
        {
          title: "Точное решение",
          description: `Начинаем с вашей задачи и предлагаем только то, что действительно помогает получить результат.`,
        },
        {
          title: "Премиальный процесс",
          description: "Чёткие этапы, внимательная коммуникация и полный контроль качества.",
        },
        {
          title: "Результат надолго",
          description: `Создаём ценность, которая работает для вас и после завершения проекта.`,
        },
      ],
      proofLabel: "Ключевые преимущества предложения",
      testimonial: {
        quote: "",
        name: "",
        role: "Отзыв будет добавлен только после подтверждения клиентом",
      },
      finalCtaTitle: "Готовы сделать следующий шаг?",
      finalCtaBody: `${input.offer}. Расскажите о задаче — ответим с понятным планом действий.`,
    },
    design: {
      themeName: premium ? "Electric Noir" : "Warm Editorial",
      background: premium ? "#0D0E12" : "#F4F0E8",
      surface: premium ? "#17181E" : "#FFFCF6",
      text: premium ? "#F7F5F0" : "#171713",
      muted: premium ? "#A2A2A8" : "#6E6B62",
      accent: premium ? "#B9FF66" : "#D15C3E",
      accentSoft: premium ? "#27351E" : "#E9D8C8",
    },
    stats: [
      { value: "01", label: "понятное предложение" },
      { value: "02", label: "ключевые услуги" },
      { value: "03", label: "простой следующий шаг" },
    ],
  };
}

const SYSTEM_PROMPT = `You are the combined research, strategy, copywriting, and art direction engine for a premium web studio.
Create a compact, high-converting one-page business website from the supplied intake.
Use the same language as the business description. Be specific, restrained, and premium; never invent regulated claims, awards, statistics, testimonials, customer names, response times, or other real customer data. If no verified testimonial is supplied, return empty strings for testimonial quote and name. Stats may only describe the page structure as 01/02/03 unless a supplied fact supports a business metric.
Return ONLY valid JSON with exactly this shape:
{
  "research": { "summary": "", "differentiators": ["", "", ""], "customerNeeds": ["", "", ""] },
  "strategy": { "positioning": "", "primaryGoal": "", "sections": ["Hero", "Services", "Proof", "Final CTA"] },
  "copy": {
    "eyebrow": "", "headline": "", "subheadline": "", "primaryCta": "", "secondaryCta": "",
    "services": [{"title":"","description":""},{"title":"","description":""},{"title":"","description":""}],
    "proofLabel": "", "testimonial": {"quote":"","name":"","role":""},
    "finalCtaTitle": "", "finalCtaBody": ""
  },
  "design": { "themeName": "", "background": "#000000", "surface": "#000000", "text": "#000000", "muted": "#000000", "accent": "#000000", "accentSoft": "#000000" },
  "stats": [{"value":"01","label":""},{"value":"02","label":""},{"value":"03","label":""}]
}`;
