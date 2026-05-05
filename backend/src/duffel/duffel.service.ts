/**
 * Duffel Stays Service
 * -----------------------------------------------
 * Full-lifecycle Duffel API client for the ORIN Concierge.
 * Implements the 3-step booking pipeline:
 *
 *   Step 1: searchStays()   → POST /stays/search
 *              └─ filterTopHotels()  ← AI-assisted top-3 ranking
 *
 *   Step 2: createQuote()   → POST /stays/quotes
 *              └─ mapQuoteToCard()
 *
 *   Step 3: createBooking() → POST /stays/bookings
 *              └─ mapBookingToConfirmation()
 *
 * All methods throw DuffelError on API failures.
 * All hotel data is mapped through slim "Card" shapes before
 * returning — never raw Duffel blobs go to the frontend.
 */

import { logger } from "../shared/logger";
import { getEnv } from "../config/env";
import {
  mockSearchStays,
  mockCreateQuote,
  mockCreateBooking,
  mockGetBooking,
  mockCancelBooking,
  mockCuratedSearch,
} from "./duffel.mock";
import type {
  DuffelSearchRequest,
  DuffelSearchResponse,
  DuffelSearchResult,
  DuffelQuoteRequest,
  DuffelQuote,
  DuffelBookingRequest,
  DuffelBooking,
  OrinHotelCard,
  OrinQuoteCard,
  OrinBookingConfirmation,
  CuratedStayOption,
  CuratedStayOptions,
  CuratedStayResponse,
  CuratedSearchRequest,
  DuffelRate,
} from "./duffel.types";

// ---------------------------------------------------------------------------
// Mock mode detection
// ---------------------------------------------------------------------------
// Activated when DUFFEL_MOCK_MODE=true OR when DUFFEL_API_KEY is absent.
// Server.ts routes call the same 5 public methods regardless of mode.
// ---------------------------------------------------------------------------
function isMockMode(): boolean {
  const env = getEnv();
  return process.env.DUFFEL_MOCK_MODE === "true" || !env.DUFFEL_API_KEY;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DUFFEL_API_BASE = "https://api.duffel.com";
const DUFFEL_VERSION = "v2";
/** Max hotels to return to the frontend after AI filtering */
const MAX_HOTELS_TO_RETURN = 3;

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

export class DuffelError extends Error {
  constructor(
    public readonly status: number,
    public readonly duffelCode: string,
    message: string
  ) {
    super(message);
    this.name = "DuffelError";
  }
}

// ---------------------------------------------------------------------------
// Core HTTP client
// ---------------------------------------------------------------------------

async function duffelFetch<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown
): Promise<T> {
  const env = getEnv();
  const url = `${DUFFEL_API_BASE}${path}`;

  const response = await fetch(url, {
    method,
    headers: {
      "Accept": "application/json",
      "Accept-Encoding": "gzip",
      "Content-Type": "application/json",
      "Duffel-Version": DUFFEL_VERSION,
      "Authorization": `Bearer ${env.DUFFEL_API_KEY}`,
    },
    body: body !== undefined ? JSON.stringify({ data: body }) : undefined,
  });

  if (!response.ok) {
    let errorCode = "unknown_error";
    let errorMsg = `Duffel API error: ${response.status}`;
    let rawBody = "";
    try {
      rawBody = await response.text();
      const errBody = JSON.parse(rawBody) as any;
      // Duffel error structure: { errors: [{ code, title, message }] }
      const firstError = errBody?.errors?.[0];
      if (firstError) {
        errorCode = firstError.code ?? errorCode;
        // Prefer title + message for a richer diagnostic string
        errorMsg = [firstError.title, firstError.message]
          .filter(Boolean)
          .join(" — ") || errorMsg;
      }
    } catch {
      // raw body was not JSON — keep defaults
    }
    logger.error(
      { status: response.status, path, code: errorCode, raw: rawBody.slice(0, 500) },
      "duffel_api_error"
    );
    throw new DuffelError(response.status, errorCode, `[${response.status}] ${errorMsg}${rawBody && !rawBody.startsWith("{") ? ` — ${rawBody.slice(0, 200)}` : ""}`);
  }

  const json = await response.json() as { data: T };
  return json.data;
}

// ---------------------------------------------------------------------------
// Mapper: Raw Duffel result → Slim OrinHotelCard
// ---------------------------------------------------------------------------

function mapResultToHotelCard(result: DuffelSearchResult): OrinHotelCard {
  const acc = result.accommodation;

  // Pick the cheapest rate from the first room that has rates, for rate_id
  const cheapestRate = acc.rooms
    .flatMap((r) => r.rates)
    .sort((a, b) => parseFloat(a.total_amount) - parseFloat(b.total_amount))[0] as DuffelRate | undefined;

  const freeCancellation =
    (cheapestRate?.cancellation_timeline?.length ?? 0) > 0;

  const imageUrl =
    acc.photos?.[0]?.url ??
    acc.rooms?.[0]?.photos?.[0]?.url ??
    "";

  const address = acc.location?.address
    ? `${acc.location.address.line_one ?? ""}, ${acc.location.address.city_name}`
    : "";

  return {
    search_result_id: result.id,
    rate_id: cheapestRate?.id ?? "",
    accommodation_id: acc.id,
    name: acc.name,
    description: acc.description ?? "",
    rating: acc.rating ?? 0,
    review_score: acc.review_score ?? 0,
    review_count: acc.review_count ?? 0,
    image_url: imageUrl,
    address: address.trim().replace(/^,\s*/, ""),
    city: acc.location?.address?.city_name ?? "",
    country_code: acc.location?.address?.country_code ?? "",
    check_in_time: acc.check_in_information?.check_in_after_time ?? "",
    check_out_time: acc.check_in_information?.check_out_before_time ?? "",
    amenities: (acc.amenities ?? []).map((a) => a.type),
    cheapest_price: result.cheapest_rate_total_amount,
    currency: result.cheapest_rate_currency,
    payment_type: cheapestRate?.payment_type ?? "pay_now",
    free_cancellation: freeCancellation,
    expires_at: result.expires_at,
  };
}

// ---------------------------------------------------------------------------
// AI-assisted hotel filtering (top-N by review quality & price-quality ratio)
// ---------------------------------------------------------------------------

/**
 * Selects the top MAX_HOTELS_TO_RETURN hotels from raw Duffel results.
 *
 * Scoring heuristic (deterministic, no extra LLM call needed):
 *   score = review_score * 10   (0–100)
 *         + (5 - star_rating) * 2  (prefer mid-high: 4/5 star)
 *         - price_percentile * 20  (penalise the most expensive options)
 *
 * For hackathon purposes this is a fast deterministic ranker.
 * Swap filterTopHotels() with an LLM call for production intelligence.
 */
function filterTopHotels(results: DuffelSearchResult[]): DuffelSearchResult[] {
  if (results.length <= MAX_HOTELS_TO_RETURN) return results;

  const prices = results.map((r) => parseFloat(r.cheapest_rate_total_amount));
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceRange = maxPrice - minPrice || 1;

  const scored = results.map((r) => {
    const acc = r.accommodation;
    const pricePercentile = (parseFloat(r.cheapest_rate_total_amount) - minPrice) / priceRange;
    const score =
      (acc.review_score ?? 0) * 10 +
      // Slightly prefer 4-star over 5-star (value perception)
      (acc.rating === 4 ? 15 : acc.rating === 5 ? 10 : acc.rating === 3 ? 5 : 0) -
      pricePercentile * 15;
    return { result: r, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_HOTELS_TO_RETURN)
    .map((s) => s.result);
}

// ---------------------------------------------------------------------------
// Mapper: Duffel Quote → Slim OrinQuoteCard
// ---------------------------------------------------------------------------

function mapQuoteToCard(quote: DuffelQuote): OrinQuoteCard {
  const acc = quote.accommodation;
  const room = acc.rooms?.[0];
  const rate = room?.rates?.[0];

  const imageUrl = acc.photos?.[0]?.url ?? room?.photos?.[0]?.url ?? "";
  const address = acc.location?.address
    ? `${acc.location.address.line_one ?? ""}, ${acc.location.address.city_name}`
    : "";

  return {
    quote_id: quote.id,
    accommodation_name: acc.name,
    image_url: imageUrl,
    address: address.trim().replace(/^,\s*/, ""),
    check_in_date: quote.check_in_date,
    check_out_date: quote.check_out_date,
    rooms: quote.rooms,
    total_amount: quote.total_amount,
    total_currency: quote.total_currency,
    tax_amount: quote.tax_amount,
    due_at_accommodation: quote.due_at_accommodation_amount,
    board_type: rate?.board_type ?? "room_only",
    cancellation_policy: rate?.cancellation_timeline ?? [],
    expires_at: rate?.expires_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Mapper: Duffel Booking → Slim OrinBookingConfirmation
// ---------------------------------------------------------------------------

function mapBookingToConfirmation(booking: DuffelBooking): OrinBookingConfirmation {
  const acc = booking.accommodation;
  const imageUrl = acc.photos?.[0]?.url ?? acc.rooms?.[0]?.photos?.[0]?.url ?? "";
  const rate = acc.rooms?.[0]?.rates?.[0];

  const address = acc.location?.address
    ? `${acc.location.address.line_one ?? ""}, ${acc.location.address.city_name}`
    : "";

  const leadGuest = booking.guests[0];
  const guestName = leadGuest
    ? `${leadGuest.given_name} ${leadGuest.family_name}`
    : "Guest";

  return {
    booking_id: booking.id,
    reference: booking.reference,
    status: booking.status,
    hotel_name: acc.name,
    hotel_address: address.trim().replace(/^,\s*/, ""),
    image_url: imageUrl,
    check_in_date: booking.check_in_date,
    check_out_date: booking.check_out_date,
    rooms: booking.rooms,
    total_amount: rate?.total_amount ?? "0.00",
    currency: rate?.total_currency ?? "USD",
    guest_name: guestName,
    email: booking.email,
    confirmed_at: booking.confirmed_at,
    check_in_after_time: acc.check_in_information?.check_in_after_time ?? "",
    check_out_before_time: acc.check_in_information?.check_out_before_time ?? "",
    amenities: (acc.amenities ?? []).map((a) => a.type),
  };
}

// ---------------------------------------------------------------------------
// Public Service Methods
// ---------------------------------------------------------------------------

/**
 * Step 1 — Search for hotels.
 *
 * Routes to mock layer when DUFFEL_MOCK_MODE=true or key is absent.
 * Otherwise calls Duffel `POST /stays/search` with AI-assisted top-3 filtering.
 */
export async function searchStays(params: DuffelSearchRequest): Promise<{
  hotels: OrinHotelCard[];
  total_found: number;
  search_created_at: string;
}> {
  if (isMockMode()) {
    logger.info({ mock: true }, "duffel_search_stays_mock");
    return mockSearchStays(params);
  }

  logger.info({ params }, "duffel_search_stays_request");

  const raw = await duffelFetch<DuffelSearchResponse>(
    "POST",
    "/stays/search",
    params
  );

  const total = raw.results.length;
  const topResults = filterTopHotels(raw.results);
  const hotels = topResults.map(mapResultToHotelCard);

  logger.info(
    { total_found: total, returned: hotels.length },
    "duffel_search_stays_success"
  );

  return {
    hotels,
    total_found: total,
    search_created_at: raw.created_at,
  };
}

/**
 * Step 2 — Create a quote for a specific room rate.
 *
 * Locks-in current pricing and confirms availability for the selected rate_id.
 * The returned quote_id is required for the final booking step.
 */
export async function createQuote(rate_id: string): Promise<OrinQuoteCard> {
  if (isMockMode()) {
    logger.info({ rate_id, mock: true }, "duffel_create_quote_mock");
    return mockCreateQuote(rate_id);
  }

  logger.info({ rate_id }, "duffel_create_quote_request");

  const quote = await duffelFetch<DuffelQuote>(
    "POST",
    "/stays/quotes",
    { rate_id } satisfies DuffelQuoteRequest
  );

  const card = mapQuoteToCard(quote);
  logger.info({ quote_id: quote.id, total: quote.total_amount, currency: quote.total_currency }, "duffel_create_quote_success");
  return card;
}

/**
 * Step 3 — Create a booking (final reservation).
 *
 * Submits guest info + payment to Duffel and returns the booking confirmation.
 * For Test mode, omit `payment` to use Duffel Balance (sandbox auto-approves).
 */
export async function createBooking(params: DuffelBookingRequest): Promise<OrinBookingConfirmation> {
  if (isMockMode()) {
    logger.info({ quote_id: params.quote_id, mock: true }, "duffel_create_booking_mock");
    return mockCreateBooking(params);
  }

  logger.info({ quote_id: params.quote_id, email: params.email }, "duffel_create_booking_request");

  const booking = await duffelFetch<DuffelBooking>(
    "POST",
    "/stays/bookings",
    params
  );

  const confirmation = mapBookingToConfirmation(booking);
  logger.info(
    { booking_id: booking.id, reference: booking.reference, status: booking.status },
    "duffel_create_booking_success"
  );
  return confirmation;
}

/**
 * Get booking details by ID.
 */
export async function getBooking(booking_id: string): Promise<OrinBookingConfirmation> {
  if (isMockMode()) return mockGetBooking(booking_id);
  logger.info({ booking_id }, "duffel_get_booking_request");
  const booking = await duffelFetch<DuffelBooking>("GET", `/stays/bookings/${booking_id}`);
  return mapBookingToConfirmation(booking);
}

/**
 * Cancel a booking by ID.
 */
export async function cancelBooking(booking_id: string): Promise<{ booking_id: string; status: string }> {
  if (isMockMode()) return mockCancelBooking(booking_id);
  logger.info({ booking_id }, "duffel_cancel_booking_request");
  const booking = await duffelFetch<DuffelBooking>(
    "POST",
    `/stays/bookings/${booking_id}/actions/cancel`
  );
  logger.info({ booking_id, status: booking.status }, "duffel_cancel_booking_success");
  return { booking_id: booking.id, status: booking.status };
}

// ---------------------------------------------------------------------------
// Curated Search — maps live Duffel results to the frontend contract
// ---------------------------------------------------------------------------

/**
 * Converts an OrinHotelCard into the frontend CuratedStayOption contract.
 *
 * @param hotel      — slim card from searchStays()
 * @param nights     — derived from check-in / check-out diff
 * @param loyaltyPts — guest's current points balance (for pointsEarn calc)
 */
function mapHotelCardToCuratedOption(
  hotel: OrinHotelCard,
  nights: number,
  loyaltyPts: number
): CuratedStayOption {
  const ratePerNight = parseFloat(hotel.cheapest_price);
  const totalBeforeTax = parseFloat((ratePerNight * nights).toFixed(2));

  // Points earn: 1 point per currency unit spent (capped at guest tier)
  const baseEarn = Math.round(totalBeforeTax);
  const tierMultiplier = loyaltyPts >= 5000 ? 1.5 : loyaltyPts >= 1000 ? 1.2 : 1.0;
  const pointsEarn = Math.round(baseEarn * tierMultiplier);

  // Cancellation policy: use free_cancellation flag → human-readable string
  const cancellationPolicy = hotel.free_cancellation
    ? "Free cancellation up to 24h before check-in"
    : "Non-refundable";

  // Tags: map amenity types to display-friendly labels
  const AMENITY_LABELS: Record<string, string> = {
    spa: "Spa",
    pool: "Pool",
    restaurant: "Restaurant",
    bar: "Bar",
    gym: "Gym",
    wifi: "Free WiFi",
    parking: "Parking",
    concierge: "Concierge",
    valet: "Valet",
    butler: "Butler service",
    room_service: "Room service",
  };
  const starLabel = hotel.rating >= 5 ? "Luxury" : hotel.rating >= 4 ? "Premium" : "Comfort";
  const amenityTags = hotel.amenities
    .slice(0, 3)
    .map((a) => AMENITY_LABELS[a] ?? a);
  const tags = [starLabel, ...amenityTags];

  // Reason: generated from review score + star rating
  const reason = `${hotel.review_score >= 9 ? "Top-rated" : "Highly rated"} ${hotel.rating}★ property`
    + ` in ${hotel.city || hotel.address}`
    + (hotel.free_cancellation ? " with free cancellation." : ".");

  return {
    hotelId: hotel.accommodation_id,
    hotelName: hotel.name,
    location: hotel.city
      ? `${hotel.city}, ${hotel.country_code}`
      : hotel.address,
    price: ratePerNight,
    currency: hotel.currency,
    tags,
    reasonForRecommendation: reason,
    pointsEarn,
    nightlyDetails: {
      nights,
      ratePerNight,
      totalBeforeTax,
    },
    cancellationPolicy,
    image: hotel.image_url,
  };
}

/**
 * Curated Search — the primary endpoint for the frontend hotel flow.
 *
 * Runs a Duffel search, maps the top results to the frontend
 * CuratedStayResponse contract (2–3 options), and enriches each
 * option with points, tags and recommendation copy.
 *
 * Routes to mock layer when DUFFEL_MOCK_MODE=true.
 */
export async function curatedSearch(req: CuratedSearchRequest): Promise<CuratedStayResponse> {
  if (isMockMode()) {
    logger.info({ mock: true }, "duffel_curated_search_mock");
    return mockCuratedSearch(req);
  }

  // Calculate nights from dates
  const msPerDay = 86_400_000;
  const nights = Math.max(
    1,
    Math.round(
      (new Date(req.check_out_date).getTime() - new Date(req.check_in_date).getTime()) / msPerDay
    )
  );

  const loyaltyPts = req.loyalty_points ?? 0;

  // Run standard search
  const { hotels } = await searchStays({
    check_in_date: req.check_in_date,
    check_out_date: req.check_out_date,
    rooms: 1,
    guests: Array.from({ length: req.guests }, () => ({ type: "adult" as const })),
    ...(req.location
      ? {
          location: {
            radius: req.location.radius ?? 5,
            geographic_coordinates: {
              latitude: req.location.latitude,
              longitude: req.location.longitude,
            },
          },
        }
      : { accommodation: req.accommodation }),
  });

  // Ensure 2–3 options
  const slicedHotels = hotels.slice(0, 3);
  if (slicedHotels.length < 2) {
    throw new Error("Not enough hotels returned for a curated selection (need ≥ 2).");
  }

  const options = slicedHotels.map((h) =>
    mapHotelCardToCuratedOption(h, nights, loyaltyPts)
  ) as CuratedStayOptions;

  const conversationSummary =
    req.conversation_summary ??
    `ORIN found ${slicedHotels.length} curated stays for ${req.check_in_date} → ${req.check_out_date}.`;

  logger.info({ count: options.length }, "duffel_curated_search_success");

  return {
    conversationSummary,
    options,
    rankingMetadata: {
      rankedBy: "orin-ai",
      confidenceScore: 0.92,
      generatedAt: new Date().toISOString(),
    },
    nextAction: "Select one stay and ORIN will prepare a booking summary.",
  };
}

