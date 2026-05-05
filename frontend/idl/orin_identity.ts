/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/orin_identity.json`.
 */
export type OrinIdentity = {
  "address": "FqtrHgdYTph1DSP9jDYD7xrKPrjSjCTtnw6fyKMmboYk",
  "metadata": {
    "name": "orinIdentity",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "initializeGuest",
      "docs": [
        "Initializes a new guest identity (On-chain Identity Layer)",
        "@param identifier_hash: SHA256 hash of the guest's unique identifier (name, email, uuid), used to derive the PDA",
        "@param name: Guest's name or nickname"
      ],
      "discriminator": [
        186,
        49,
        55,
        126,
        55,
        88,
        244,
        112
      ],
      "accounts": [
        {
          "name": "guestProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "identifierHash"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "user",
          "signer": true
        },
        {
          "name": "feePayer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "identifierHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "name",
          "type": "string"
        }
      ]
    },
    {
      "name": "recordBooking",
      "docs": [
        "Records a completed booking and rewards the guest with ORIN Credits.",
        "",
        "Access control: only the ORIN backend authority wallet (the designated",
        "`booking_authority` signer) may call this instruction. This prevents guests",
        "from self-awarding credits and ensures all bookings are validated server-side",
        "before being committed on-chain.",
        "",
        "@param points_earned: Number of ORIN Credits to add (u64, checked arithmetic)"
      ],
      "discriminator": [
        30,
        238,
        92,
        20,
        218,
        26,
        2,
        179
      ],
      "accounts": [
        {
          "name": "guestProfile",
          "writable": true
        },
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "guestProfile"
          ]
        }
      ],
      "args": [
        {
          "name": "pointsEarned",
          "type": "u64"
        }
      ]
    },
    {
      "name": "updatePreferences",
      "docs": [
        "Updates the guest's ambient preferences (Privacy-First Hash Verification Logic)",
        "@param new_prefs_hash: The SHA256 Hash of the off-chain JSON preference string"
      ],
      "discriminator": [
        16,
        64,
        128,
        133,
        19,
        206,
        101,
        159
      ],
      "accounts": [
        {
          "name": "guestProfile",
          "writable": true
        },
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "guestProfile"
          ]
        }
      ],
      "args": [
        {
          "name": "newPrefsHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "guestIdentity",
      "discriminator": [
        135,
        23,
        70,
        222,
        201,
        72,
        88,
        229
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "nameTooLong",
      "msg": "The provided name is too long. Please limit to 100 characters."
    },
    {
      "code": 6001,
      "name": "unauthorizedAccess",
      "msg": "Identity verification failed: Only the owner of this account can modify its data."
    },
    {
      "code": 6002,
      "name": "unauthorizedBooking",
      "msg": "Booking authority mismatch: Only the ORIN backend server wallet may record bookings."
    },
    {
      "code": 6003,
      "name": "pointsOverflow",
      "msg": "Arithmetic overflow: loyalty_points or stay_count has reached its maximum value."
    }
  ],
  "types": [
    {
      "name": "guestIdentity",
      "docs": [
        "---------------------------",
        "Data Structures (State)",
        "---------------------------"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "identifierHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "preferencesHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "loyaltyPoints",
            "type": "u64"
          },
          {
            "name": "stayCount",
            "type": "u32"
          }
        ]
      }
    }
  ]
};
