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
  checkInDate: string;
  checkOutDate: string;
  guests: number;
  selectedOption: CuratedStayOption;
  priceLines: BookingPriceLine[];
  pointsRedemption: PointsRedemption;
  payableTotal: number;
  currency: string;
}