use anchor_lang::prelude::*;

// Replace this with your actual generated Program ID
declare_id!("FqtrHgdYTph1DSP9jDYD7xrKPrjSjCTtnw6fyKMmboYk");

pub const ORIN_REWARD_AUTHORITY_PUBKEY: Pubkey = pubkey!("9YHkGPHXQGmp6M7hSam6nCxmQAcKhG5KTr6a3dAacvVC"); // Needs to be swapped to the dedicated reward wallet pubkey!

#[program]
pub mod orin_identity {
    use super::*;

    /// Initializes a new guest identity (On-chain Identity Layer)
    /// @param identifier_hash: SHA256 hash of the guest's unique identifier (name, email, uuid), used to derive the PDA
    /// @param name: Guest's name or nickname
    pub fn initialize_guest(
        ctx: Context<InitializeGuest>,
        identifier_hash: [u8; 32],
        name: String,
    ) -> Result<()> {
        // 1. Parameter validation: Limit name length (Max 100 characters/bytes)
        require!(name.as_bytes().len() <= 100, OrinError::NameTooLong);

        let guest_profile = &mut ctx.accounts.guest_profile;

        // 2. Initialize fields
        guest_profile.owner     = *ctx.accounts.user.key;      // Bind the guest wallet as the owner
        guest_profile.authority = ORIN_REWARD_AUTHORITY_PUBKEY; // Force the isolated reward pubkey as the exclusive booking authority
        guest_profile.identifier_hash = identifier_hash;       // Store generic identifier hash for off-chain querying
        guest_profile.name = name;                       // Store guest name
        guest_profile.loyalty_points = 0;                // Initialize ORIN Credits to 0
        guest_profile.stay_count = 0;                    // Initialize booking count to 0
        guest_profile.preferences_hash = [0; 32];        // Wait for off-chain payload hash

        msg!("Guest Identity Initialized: {}", guest_profile.name);
        Ok(())
    }

    /// Updates the guest's ambient preferences (Privacy-First Hash Verification Logic)
    /// @param new_prefs_hash: The SHA256 Hash of the off-chain JSON preference string 
    pub fn update_preferences(ctx: Context<UpdatePreferences>, new_prefs_hash: [u8; 32]) -> Result<()> {
        let guest_profile = &mut ctx.accounts.guest_profile;

        // 1. Update preferences verification hash
        guest_profile.preferences_hash = new_prefs_hash;

        // 2. Automatically increment room adjustments count (simplified logic: each update represents an environmental activation)
        guest_profile.stay_count += 1;

        msg!("Preferences HASH updated for Guest: {:?}", guest_profile.preferences_hash);
        Ok(())
    }

    /// Records a completed booking and rewards the guest with ORIN Credits.
    ///
    /// Access control: only the ORIN backend authority wallet (the designated
    /// `booking_authority` signer) may call this instruction. This prevents guests
    /// from self-awarding credits and ensures all bookings are validated server-side
    /// before being committed on-chain.
    ///
    /// @param points_earned: Number of ORIN Credits to add (u64, checked arithmetic)
    pub fn record_booking(ctx: Context<RecordBooking>, points_earned: u64) -> Result<()> {
        let guest_profile = &mut ctx.accounts.guest_profile;

        // Checked addition guards against u64 overflow (production safety)
        guest_profile.loyalty_points = guest_profile
            .loyalty_points
            .checked_add(points_earned)
            .ok_or(OrinError::PointsOverflow)?;

        // Checked addition guards against u32 overflow on stay counter
        guest_profile.stay_count = guest_profile
            .stay_count
            .checked_add(1)
            .ok_or(OrinError::PointsOverflow)?;

        msg!(
            "Booking recorded for guest '{}'. Stay #{}, ORIN Credits earned: {}, Total credits: {}",
            guest_profile.name,
            guest_profile.stay_count,
            points_earned,
            guest_profile.loyalty_points
        );
        Ok(())
    }
}

/// ---------------------------
/// Contexts & Access Control
/// ---------------------------

#[derive(Accounts)]
#[instruction(identifier_hash: [u8; 32])]
pub struct InitializeGuest<'info> {
    // PDA (Program Derived Address) design:
    // Seeds combine "guest" + identifier + user's wallet pubkey, ensuring absolute uniqueness and locking out malicious squatters
    #[account(
        init,
        payer = fee_payer,  // Can be the server (Relayer) or the user themselves in direct-pay mode
        // Space: 8 discriminator + 32 owner + 32 authority + 32 identifier_hash + (4+100) name
        //      + 32 preferences_hash + 8 loyalty_points + 4 stay_count = 252 bytes
        space = 8 + 32 + 32 + 32 + (4 + 100) + 32 + 8 + 4,
        seeds = [b"guest", identifier_hash.as_ref(), user.key().as_ref()],
        bump
    )]
    pub guest_profile: Account<'info, GuestIdentity>,

    pub user: Signer<'info>,  // Guest wallet: signs to prove ownership (no SOL required)

    #[account(mut)]
    pub fee_payer: Signer<'info>,  // ORIN server wallet: funds account creation rent

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePreferences<'info> {
    // Access control core: has_one = owner
    // This enforces `guest_profile.owner == owner.key`
    // Only the "account creator" has permission to modify preferences, preventing unauthorized tampering
    #[account(
        mut,
        has_one = owner @ OrinError::UnauthorizedAccess
    )]
    pub guest_profile: Account<'info, GuestIdentity>,

    pub owner: Signer<'info>, // Must be the signature of the account owner
}

/// Context for the record_booking instruction.
///
/// Access control design:
///   - `guest_profile` is mutable (loyalty_points and stay_count are written).
///   - `booking_authority` is a Signer whose public key must match the
///     `authority` field stored in the account at initialization.
///     This binds the ORIN backend server wallet as the sole entity
///     permitted to issue credits — guests cannot self-award points.
#[derive(Accounts)]
pub struct RecordBooking<'info> {
    #[account(
        mut,
        // Enforce that only the stored authority can call this instruction.
        // `has_one` checks: guest_profile.authority == booking_authority.key()
        has_one = authority @ OrinError::UnauthorizedBooking
    )]
    pub guest_profile: Account<'info, GuestIdentity>,

    // The ORIN backend server wallet — must sign every record_booking call.
    // This is the same fee_payer wallet used throughout the relay system.
    pub authority: Signer<'info>,
}

/// ---------------------------
/// Data Structures (State)
/// ---------------------------

#[account]
pub struct GuestIdentity {
    pub owner: Pubkey,               // 32 bytes: Account owner (AA context or private key wallet)
    pub authority: Pubkey,           // 32 bytes: ORIN backend server wallet — the only key that may call record_booking
    pub identifier_hash: [u8; 32],   // 32 bytes: Associated generic identifier hash
    pub name: String,                // 4 + 100 bytes: User's name/nickname
    pub preferences_hash: [u8; 32],  // 32 bytes: Security HASH validating the off-chain environment preferences
    pub loyalty_points: u64,         // 8 bytes: ORIN Credits (mapped from loyalty_points for display)
    pub stay_count: u32,             // 4 bytes: Total completed bookings (canonical count; details stored off-chain)
}

/// ---------------------------
/// Error Handling
/// ---------------------------

#[error_code]
pub enum OrinError {
    #[msg("The provided name is too long. Please limit to 100 characters.")]
    NameTooLong,
    #[msg("Identity verification failed: Only the owner of this account can modify its data.")]
    UnauthorizedAccess,
    #[msg("Booking authority mismatch: Only the ORIN backend server wallet may record bookings.")]
    UnauthorizedBooking,
    #[msg("Arithmetic overflow: loyalty_points or stay_count has reached its maximum value.")]
    PointsOverflow,
}
