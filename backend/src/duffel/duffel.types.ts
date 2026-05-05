/**
 * Duffel Stays API — TypeScript Type Definitions
 * -----------------------------------------------
 * Covers the full 3-step booking lifecycle:
 *   1. Search  → POST /stays/search
 *   2. Quote   → POST /stays/quotes
 *   3. Booking → POST /stays/bookings
 *
 * Based on Duffel API v2 documentation (Duffel-Version: v2)
 */

// ---------------------------------------------------------------------------
// Shared sub-types
// ---------------------------------------------------------------------------

export interface DuffelGeographicCoordinates {
  longitude: number;
  latitude: number;
}

export interface DuffelAddress {
  region?: string;
  postal_code?: string;
  line_one?: string;
  country_code: string;
  city_name: string;
}

export interface DuffelLocation {
  geographic_coordinates: DuffelGeographicCoordinates;
  address?: DuffelAddress;
}

export interface DuffelPhoto {
  url: string;
}

export interface DuffelAmenity {
  type: string;
  description: string;
}

export interface DuffelBed {
  type: string;
  count: number;
}

export interface DuffelCancellationEntry {
  refund_amount: string;
  currency: string;
  before: string;
}

export interface DuffelRateCondition {
  title: string;
  description: string;
}

export interface DuffelCheckInInformation {
  check_out_before_time: string;
  check_in_before_time: string;
  check_in_after_time: string;
}

export interface DuffelBrand {
  name: string;
  id: string;
}

export interface DuffelChain {
  name: string;
}

export interface DuffelKeyCollection {
  instructions: string;
}

// ---------------------------------------------------------------------------
// Rate (room rate)
// ---------------------------------------------------------------------------

export interface DuffelRate {
  id: string;
  total_amount: string;
  total_currency: string;
  base_amount: string | null;
  base_currency: string;
  tax_amount: string | null;
  tax_currency: string;
  fee_amount: string | null;
  fee_currency: string;
  due_at_accommodation_amount: string | null;
  due_at_accommodation_currency: string;
  public_amount: string;
  public_currency: string;
  payment_type: "pay_now" | "pay_at_accommodation";
  available_payment_methods: string[][];
  board_type: string;
  description?: string;
  expires_at: string;
  quantity_available: number;
  cancellation_timeline: DuffelCancellationEntry[];
  conditions?: DuffelRateCondition[];
  deal_types?: string[];
  code?: string;
  negotiated_rate_id?: string;
  supported_loyalty_programme?: string;
  loyalty_programme_required?: boolean;
  estimated_commission_amount?: string;
  estimated_commission_currency?: string;
}

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

export interface DuffelRoom {
  name: string;
  rates: DuffelRate[];
  photos: DuffelPhoto[];
  beds: DuffelBed[];
}

// ---------------------------------------------------------------------------
// Accommodation (full object returned by search / quote / booking)
// ---------------------------------------------------------------------------

export interface DuffelAccommodation {
  id: string;
  name: string;
  description?: string;
  rating?: number;
  review_score?: number;
  review_count?: number;
  phone_number?: string;
  email?: string;
  photos: DuffelPhoto[];
  location: DuffelLocation;
  amenities?: DuffelAmenity[];
  rooms: DuffelRoom[];
  check_in_information?: DuffelCheckInInformation;
  key_collection?: DuffelKeyCollection;
  brand?: DuffelBrand;
  chain?: DuffelChain;
  supported_loyalty_programme?: string;
  payment_instruction_supported?: boolean;
}

// ---------------------------------------------------------------------------
// Search types
// ---------------------------------------------------------------------------

export interface DuffelGuestInput {
  type: "adult" | "child";
  age?: number;
}

export interface DuffelSearchLocation {
  radius: number;
  geographic_coordinates: DuffelGeographicCoordinates;
}

export interface DuffelSearchAccommodation {
  id: string;
}

export interface DuffelSearchRequest {
  check_in_date: string;        // ISO 8601 date e.g. "2024-06-04"
  check_out_date: string;       // ISO 8601 date e.g. "2024-06-07"
  rooms: number;
  guests: DuffelGuestInput[];
  location?: DuffelSearchLocation;
  accommodation?: DuffelSearchAccommodation;
  free_cancellation_only?: boolean;
  instant_payment?: boolean;
  mobile?: boolean;
}

export interface DuffelSearchResult {
  id: string;                              // srr_xxx — used as search_result_id
  accommodation: DuffelAccommodation;
  cheapest_rate_total_amount: string;
  cheapest_rate_currency: string;
  cheapest_rate_public_amount: string;
  cheapest_rate_public_currency: string;
  cheapest_rate_base_amount: string;
  cheapest_rate_base_currency: string;
  cheapest_rate_due_at_accommodation_amount?: string;
  cheapest_rate_due_at_accommodation_currency?: string;
  check_in_date: string;
  check_out_date: string;
  rooms: number;
  guests: DuffelGuestInput[];
  expires_at: string;
}

export interface DuffelSearchResponse {
  results: DuffelSearchResult[];
  created_at: string;
}

// ---------------------------------------------------------------------------
// Quote types
// ---------------------------------------------------------------------------

export interface DuffelQuoteRequest {
  rate_id: string;
}

export interface DuffelQuote {
  id: string;                              // quo_xxx
  accommodation: DuffelAccommodation;
  total_amount: string;
  total_currency: string;
  base_amount: string | null;
  base_currency: string;
  tax_amount: string | null;
  tax_currency: string;
  fee_amount: string | null;
  fee_currency: string;
  due_at_accommodation_amount: string | null;
  due_at_accommodation_currency: string;
  deposit_amount: string | null;
  deposit_currency: string;
  check_in_date: string;
  check_out_date: string;
  rooms: number;
  guests?: DuffelGuestInput[];
  supported_loyalty_programme?: string;
}

// ---------------------------------------------------------------------------
// Booking types
// ---------------------------------------------------------------------------

export interface DuffelBookingGuest {
  given_name: string;
  family_name: string;
  user_id?: string;
}

/** Payment via Duffel balance — omit `payment` field in request body */
export type DuffelPaymentBalance = null;

/** Payment via card (3DS session) */
export interface DuffelPaymentCard {
  three_d_secure_session_id: string;
}

export interface DuffelBookingRequest {
  quote_id: string;
  email: string;
  phone_number: string;
  guests: DuffelBookingGuest[];
  payment?: DuffelPaymentCard;
  accommodation_special_requests?: string;
  loyalty_programme_account_number?: string;
  metadata?: Record<string, string>;
  users?: string[];
}

export interface DuffelBooking {
  id: string;                              // bok_xxx
  status: "confirmed" | "cancelled";
  reference: string | null;               // Hotel confirmation code (e.g. "AFE33SE2")
  accommodation: DuffelAccommodation;
  guests: DuffelBookingGuest[];
  email: string;
  phone_number: string;
  check_in_date: string;
  check_out_date: string;
  rooms: number;
  confirmed_at: string | null;
  cancelled_at: string | null;
  estimated_commission_amount?: string | null;
  estimated_commission_currency?: string | null;
  loyalty_programme_account_number?: string | null;
  supported_loyalty_programme?: string | null;
  metadata?: Record<string, string> | null;
  users?: string[];
}

// ---------------------------------------------------------------------------
// Mapped / slim response types used by our API layer
// (We never send the full Duffel blob to the frontend)
// ---------------------------------------------------------------------------

export interface OrinHotelCard {
  search_result_id: string;   // srr_xxx — needed to re-fetch rates
  rate_id: string;            // Cheapest rate ID for quick quote creation
  accommodation_id: string;
  name: string;
  description: string;
  rating: number;             // 1–5 star
  review_score: number;       // 0–10
  review_count: number;
  image_url: string;
  address: string;
  city: string;
  country_code: string;
  check_in_time: string;
  check_out_time: string;
  amenities: string[];
  cheapest_price: string;
  currency: string;
  payment_type: string;
  free_cancellation: boolean;
  expires_at: string;
}

export interface OrinQuoteCard {
  quote_id: string;           // quo_xxx — needed for booking
  accommodation_name: string;
  image_url: string;
  address: string;
  check_in_date: string;
  check_out_date: string;
  rooms: number;
  total_amount: string;
  total_currency: string;
  tax_amount: string | null;
  due_at_accommodation: string | null;
  board_type: string;
  cancellation_policy: DuffelCancellationEntry[];
  expires_at: string | null;
}

export interface OrinBookingConfirmation {
  booking_id: string;         // bok_xxx
  reference: string | null;   // Hotel-issued confirmation code
  status: "confirmed" | "cancelled";
  hotel_name: string;
  hotel_address: string;
  image_url: string;
  check_in_date: string;
  check_out_date: string;
  rooms: number;
  total_amount: string;
  currency: string;
  guest_name: string;
  email: string;
  confirmed_at: string | null;
  check_in_after_time: string;
  check_out_before_time: string;
  amenities: string[];
}

// ---------------------------------------------------------------------------
// Frontend Curated Booking Contract
// ---------------------------------------------------------------------------
// These types EXACTLY mirror frontend/src/lib/curatedBookingContract.ts.
// The /api/v1/stays/curated-search endpoint returns CuratedStayResponse.
// ---------------------------------------------------------------------------

export interface CuratedStayOption {
  hotelId: string;
  hotelName: string;
  location: string;
  price: number;
  currency: string;
  tags: string[];
  reasonForRecommendation: string;
  pointsEarn: number;
  nightlyDetails: {
    nights: number;
    ratePerNight: number;
    totalBeforeTax: number;
  };
  cancellationPolicy: string;
  image: string;
}

/** Always 2 or 3 options — matches frontend tuple type */
export type CuratedStayOptions =
  | [CuratedStayOption, CuratedStayOption]
  | [CuratedStayOption, CuratedStayOption, CuratedStayOption];

export interface CuratedStayResponse {
  conversationSummary: string;
  options: CuratedStayOptions;
  rankingMetadata: {
    rankedBy: "orin-ai";
    confidenceScore: number;
    generatedAt: string;
  };
  nextAction: string;
}

export interface BookingPriceLine {
  label: string;
  amount: number;
  lineType: "base" | "tax" | "discount";
}

export interface PointsRedemption {
  pointsUsed: number;
  discountAmount: number;
}

export interface BookingSummary {
  checkInDate: string;         // YYYY-MM-DD
  checkOutDate: string;        // YYYY-MM-DD
  guests: number;
  selectedOption: CuratedStayOption;
  priceLines: BookingPriceLine[];
  pointsRedemption: PointsRedemption;
  payableTotal: number;
  currency: string;
}

/** Input shape for the curated search endpoint */
export interface CuratedSearchRequest {
  check_in_date: string;
  check_out_date: string;
  guests: number;
  location?: { latitude: number; longitude: number; radius?: number };
  accommodation?: { id: string };
  conversation_summary?: string;   // Optional: what the user said to ORIN
  loyalty_points?: number;         // For pointsEarn calculation
}
