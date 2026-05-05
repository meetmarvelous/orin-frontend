import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { OrinIdentity } from "../target/types/orin_identity";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import { expect } from "chai";

describe("orin_identity", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  
  const program = anchor.workspace.orinIdentity as Program<OrinIdentity>;

  const testEmail = "test.guest@orin.network";
  let guestPda: PublicKey;
  let emailHashBuffer: Buffer;

  before(async () => {
    emailHashBuffer = createHash("sha256").update(testEmail.toLowerCase().trim()).digest();
    
    [guestPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("guest"), emailHashBuffer],
      program.programId
    );
  });

  it("Initializes a new Guest Identity!", async () => {
    const guestName = "Satoshi Nakamoto";

    const tx = await program.methods
      .initializeGuest(Array.from(emailHashBuffer), guestName)
      .accounts({
        guestProfile: guestPda,
        user: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .rpc();
    
    console.log("💳 Initialize TX Signature:", tx);

    const guestAccount = await program.account.guestIdentity.fetch(guestPda);

    expect(guestAccount.name).to.equal(guestName);
    // Ensure the hash is initialized to 32 bytes of zeros
    expect(guestAccount.preferencesHash).to.deep.equal(Array(32).fill(0));
    expect(guestAccount.owner.toBase58()).to.equal(provider.wallet.publicKey.toBase58());
    expect(guestAccount.stayCount).to.equal(0);
  });

  it("Updates the Guest's Ambient Preferences (Privacy-First Hash Lock)!", async () => {
    // We never send the JSON structure on-chain anymore. Just the hash verification lock.
    const newPreferencesRaw = JSON.stringify({
      temp: 21.5,
      brightness: 100,
      light_color: "#1E90FF",
      color_mode: "FOCUS",
    });
    
    // Hash the precise untampered payload
    const newPreferencesHashBuffer = createHash("sha256").update(newPreferencesRaw.trim()).digest();

    const tx = await program.methods
      .updatePreferences(Array.from(newPreferencesHashBuffer))
      .accounts({
        guestProfile: guestPda,
        owner: provider.wallet.publicKey,
      } as any)
      .rpc();

    console.log("🎛️ Update Preferences Verification Hash TX Signature:", tx);

    const updatedAccount = await program.account.guestIdentity.fetch(guestPda);

    // Verify it stored the exact exact 32 bytes footprint
    expect(updatedAccount.preferencesHash).to.deep.equal(Array.from(newPreferencesHashBuffer));
    expect(updatedAccount.stayCount).to.equal(1);

    console.log("\n✅ [Test Passed] On-chain verification hash is perfectly secured.");
  });

  it("Fails when an unauthorized user tries to update preferences", async () => {
    const attackerKeypair = anchor.web3.Keypair.generate();
    let errorOccurred = false;
    
    try {
      await program.methods
        .updatePreferences(Array(32).fill(1)) // malicious hash
        .accounts({
          guestProfile: guestPda,
          owner: attackerKeypair.publicKey,
        } as any)
        .signers([attackerKeypair])
        .rpc();
    } catch (error: any) {
      errorOccurred = true;
      expect(error.message).to.include("UnauthorizedAccess");
    }

    expect(errorOccurred).to.be.true;
    console.log("🛡️ Access control correctly blocked the malicious update!");
  });
});
