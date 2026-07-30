// timeofday.h - the sun's position, the sky's colour and the fog, as a function of the clock
//
// Every map in mapgen.h hard-codes one lighting condition: two of them a bright noon, one a
// warm sunset. That was fine while the maps were being built, but it means the sandbox's
// advertised time-of-day control has nothing to drive, and the condition the renderer is
// actually being tuned for -- a harbour at dusk in heavy fog, where the quay lamps are the
// dominant light and lay long shafts across dark water -- cannot be reached at all. This
// header produces a `SkyState` for any hour, which the caller copies into the `MapInfo`
// fields the shaders already read (`sunDir`, `sunColor`, `skyHorizon`, `skyZenith`,
// `ambient`, `fogDensity`).
//
// Two things are worth knowing before reading further.
//
// The colours here are *driven by air mass*, not by a colour ramp keyed to the clock. The sun
// reddens near the horizon because its light crosses far more atmosphere and the short
// wavelengths scatter out of the beam; air mass is the quantity that measures exactly that, it
// rises very sharply as the elevation approaches zero, and it does not care whether the sun is
// on its way up or down. Driving off it means dawn and dusk agree by construction rather than
// by being tuned twice, and the whole transition is smooth without a single hand-placed
// keyframe. A ramp of the form "at 18:00 the sun is orange, at 19:00 it is red" would have had
// to be authored twice, would have drifted apart the first time either half was touched, and
// would have had to be re-authored for any other latitude or season.
//
// `SkyState` deliberately does not include `skyStyle`. That field selects between two cloud
// palettes and switches the sky shader's stars on, which is an art decision about the map, not
// a consequence of the hour; the caller should set it, and `sunDir.y > -0.42f` (sun below
// about 25 degrees of elevation) is a reasonable rule if it wants one.

#pragma once
#include "vmath.h"

struct SkyState {
    vec3 sunDir;        // NORMALISED, pointing FROM the sun TOWARD the scene (as MapInfo uses it)
    vec3 sunColor;      // linear HDR, can exceed 1
    vec3 skyHorizon;
    vec3 skyZenith;
    float ambient;      // 0..1-ish, the renderer's ambient term
    float fogDensity;
    float exposureHint; // suggested scene exposure multiplier, 1.0 at midday
};

// ---------------------------------------------------------------- where and when we are
//
// A solar position model needs a latitude and a solar declination (which is to say, a season),
// and leaving them implicit inside the trigonometry would make every number below unfalsifiable.
// So they are stated: **52 degrees north at a declination of +10 degrees**, which is a North Sea
// coast in early May or early August.
//
// Both were chosen against things that already exist rather than picked for tidiness:
//
// - Declination +10 at latitude 52 puts the noon sun at 48 degrees of elevation. The three
//   hand-authored maps use noon sun directions with a y of -0.78, -0.72 and -0.30, so 48
//   degrees (y = -0.74) sits right on top of the two daytime ones. Switching a map over to this
//   model therefore does not change how it looks at midday, which is the only way the change can
//   be landed without re-judging every existing screenshot.
// - It puts sunset at 18:52 and sunrise at 05:08. The textbook alternative -- equinox at 45
//   north -- gives a much neater 06:00/18:00, but a noon sun of only 45 degrees and, more to the
//   point, a dusk that lands exactly on the hour. Real dusk does not, and the target look wants
//   an evening hour you can dial to (19:00 is deep dusk here, 19:30 is nearly night).
//
// Anyone wanting a different place or season changes these two numbers and nothing else; the
// rest of the file is derived.
static const float TOD_LATITUDE_DEG    = 52.0f;
static const float TOD_DECLINATION_DEG = 10.0f;

static const float TOD_PI  = 3.14159265358979f;
static const float TOD_D2R = TOD_PI / 180.0f;

// ---------------------------------------------------------------- atmosphere
//
// Rayleigh optical depth of the whole sea-level atmosphere, per channel, from the standard
// 0.008735 * lambda^-4.08 (lambda in micrometres). The wavelengths are 680/550/440 nm, the
// values conventionally taken as the RGB centroids in atmospheric-scattering work. Those are
// deliberately wider apart than the sRGB primaries' dominant wavelengths (610/549/465), and the
// difference is not cosmetic: lambda^-4 is so steep that using the narrower set halves the
// red-to-blue separation and the sunsets come out muddy rather than warm.
static const vec3 TOD_TAU_RAYLEIGH = vec3(0.0421359f, 0.1001320f, 0.2488932f);

// Aerosol (Mie) optical depth, as beta * (lambda/0.55)^-1.3 -- the Angstrom law with a typical
// continental exponent. Two reasons it is here rather than being left out for simplicity.
//
// First, pure Rayleigh understates how much a low sun dims, because real air always carries
// some haze. Second, and more usefully, aerosol extinction is much *less* wavelength-selective
// than Rayleigh, so raising it with `haze` correctly makes a hazy sunset a pale dim disc rather
// than a fiery one. That is the right behaviour and it falls out for free instead of needing a
// separate "desaturate the sun in fog" hack.
static const vec3 TOD_AEROSOL_SHAPE = vec3(0.759010f, 1.0f, 1.336566f);
static const float TOD_AEROSOL_BASE = 0.030f;   // clear-air AOD at 550 nm
static const float TOD_AEROSOL_HAZE = 0.250f;   // added at haze = 1; 0.28 total is a proper murk

// How much of the aerosol's scattering ends up in a general patch of sky rather than in the
// glare right around the sun. Mie scattering off haze droplets is strongly forward-peaked
// (asymmetry parameter ~0.75), while Rayleigh scattering off molecules is nearly isotropic, so
// per unit of optical depth the haze contributes far less to the sky away from the sun than the
// molecules do. This fraction is what makes the sky's colour still mostly Rayleigh blue in
// clear air while the haze's neutral grey takes over as `haze` rises.
//
// The first version of this file wrote the same quantity as tau_rayleigh/tau_total, i.e. as
// though aerosol extinction removed light from the sky altogether. It gave a good clear-day
// blue and a badly wrong fog: the sky went *darker* as fog thickened, when the entire visual
// signature of fog is that it is a bright luminous sheet. Measured, the noon horizon sky
// averaged 0.35 across the three channels at haze = 1 against 0.80 in clear air; with the
// aerosol's scattering counted it averages 0.58, which is the white-out it should be.
static const float TOD_MIE_ISOTROPIC = 0.35f;

// Air mass is capped at 19.5, which is the Kasten-Young value for an elevation of 2 degrees.
//
// This is not a numerical guard, it is a geometry correction. The sun's own transmittance to a
// point at sea level really does run away to an air mass of ~38 at the horizon, and taking that
// literally gives a black sun and an almost black horizon glow, because it ignores that the air
// producing the glow is several kilometres up and tens of kilometres away. From 4 km the horizon
// dips by about 2 degrees, so that air sees the sun about 2 degrees higher than we do. Capping
// at the 2-degree air mass is exactly that dip, expressed in the one variable the model has.
static const float TOD_AIRMASS_MAX = 19.5f;

// Extraterrestrial sun scale, in the renderer's linear units. Set so that the noon sun comes out
// at roughly (3.76, 3.44, 2.78), which is the (3.75, 3.51, 3.06) the two daytime maps were
// authored with, to within the small extra warmth this model's wavelengths give.
static const float TOD_SUN_IRRADIANCE = 4.10f;

// View air mass for the two sky samples the renderer wants. The zenith looks through one air
// mass by definition. The horizon is geometrically ~38, but is used at 28 here: the same
// argument as the cap above, plus the fact that the "horizon" a 64 x 64 m map ever shows is the
// near one. Turned down toward 16 the daytime horizon goes noticeably bluer than the maps were
// authored with; turned up past 32 it saturates to a flat neutral white.
static const float TOD_VIEW_AM_HORIZON = 28.0f;
static const float TOD_VIEW_AM_ZENITH  = 1.0f;

// The colour of multiply-scattered skylight, and how much of it each sample gets.
//
// Single scattering alone gets the zenith right at noon and badly wrong at sunset: it predicts
// an *orange* zenith, because it assumes the light reaching the air above your head came along
// the same heavily reddened sea-level path the direct beam did. It did not. Light that has
// bounced several times has been through many different paths and has lost most of the lambda^-4
// selectivity, so it stays a pale blue long after the direct beam has gone red -- which is why
// the sky overhead is deep blue while the west is on fire. This term is that light. It is a pale
// blue rather than the saturated Rayleigh blue for the same reason: repeated scattering washes
// the colour out toward white.
static const vec3 TOD_MS_CHROMA   = vec3(0.26f, 0.46f, 1.0f);
static const float TOD_MS_GAIN_H  = 0.40f;   // horizon: enough blue to keep sunset off pure red
static const float TOD_MS_GAIN_Z  = 0.60f;   // zenith: multiple scattering dominates there

// Two scalar gains, and the only two numbers in this file fitted to an existing look rather
// than derived: they put the clear-noon sky at (0.66, 0.82, 0.92) on the horizon and
// (0.20, 0.36, 0.75) at the zenith, which is what genMall() and genHub() were hand-authored
// with. Matching them is what lets a map be switched over to this model without every daytime
// screenshot taken so far needing to be re-judged.
static const float TOD_SKY_GAIN_H = 0.96f;
static const float TOD_SKY_GAIN_Z = 1.13f;

// ---------------------------------------------------------------- night and twilight
//
// A scene that goes to literal zero is unreadable and reads as a bug, not as night. Below the
// horizon the direct sun contributes nothing, but the sky keeps a floor: moonlight, airglow, and
// for a harbour, the glow of the town behind you. The horizon floor is brighter and slightly
// warmer than the zenith floor for that last reason.
//
// These are small numbers (the night sky is ~0.003 against a daytime horizon of ~0.92) and they
// are meant to be: `exposureHint` is what brings them back up to something viewable, so the
// darkness stays in the scene's radiance where it belongs rather than being pre-baked into a
// grey sky that then cannot be exposed down.
static const vec3 TOD_NIGHT_HORIZON = vec3(0.0026f, 0.0026f, 0.0034f);
static const vec3 TOD_NIGHT_ZENITH  = vec3(0.0009f, 0.0012f, 0.0022f);

// Twilight brightness falls by about a decade for every 4 degrees the sun sinks below the
// horizon. That is roughly what photometry of real twilight shows, and it is what makes civil
// and nautical twilight a gradual hour-long fade instead of a step at sunset: the sky is at a
// tenth of its sunset value 4 degrees down (about 19:22 here), a hundredth 8 degrees down
// (about 19:52), and has settled onto the night floor by the time it is fully dark. The floor is *added* to the
// decaying term rather than clamped against it, so there is no kink where the two meet.
static const float TOD_TWILIGHT_DECADE_DEG = 4.0f;

// The direct beam, by contrast, switches off fast, over an elevation window of about +/-1.2
// degrees -- the sun's disc is half a degree across and refraction lifts it by another half, so
// in reality the last direct light is gone within a few minutes of the disc touching the
// horizon. Making this window wider to be "safe" would be wrong twice over: it would keep a
// visible key light going after sunset, and it would flatten the one moment the whole look is
// being built around, when the sun goes and the quay lamps take over.
static const float TOD_SUN_FADE_DEG = 1.2f;

// ---------------------------------------------------------------- fog
//
// The shaders use `1 - exp(-pow(dist * uFogDensity, 1.5))`, so the distance at which fog covers
// 90% of a surface is d = ln(10)^(2/3) / density = 1.7438 / density. The clear value matches the
// daytime maps (0.0032, i.e. ~545 m, which is clear across a 64 m world); the heavy value of
// 0.0349 puts that 90% distance at 50 m, so in heavy fog you lose the far quay wall and the
// lamps become the only thing establishing depth.
//
// The interpolation is geometric rather than linear because contrast loss is multiplicative:
// stepping the density linearly spends most of the slider's travel in a range that looks
// identical on a 64 m map. Geometrically, haze = 0.5 gives 0.0106, which is 16% fog at 30 m --
// visible mist, which is what the middle of a slider ought to look like.
//
// Time of day is deliberately *not* wired into this even though real radiation fog peaks around
// dawn, so that `haze` stays the single honest knob: a caller asking for haze = 0 gets clear air
// at every hour, and can add its own dawn mist if it wants one.
static const float TOD_FOG_CLEAR = 0.0032f;
static const float TOD_FOG_HEAVY = 0.0349f;

// How much of the light-level change exposure gives back. Fully compensating (exponent 1) would
// make midnight look like noon, which defeats the point; not compensating at all leaves midnight
// unviewable. 0.40 is a partial adaptation, the same compromise film and the eye make, and over
// a clear day it measures 1.00 at noon, 1.25 at 17:00, 1.57 at 18:00, 5.69 at 19:00 and 19.2 at
// midnight -- so about a 19x span, against a real luminance range of many thousands to one.
static const float TOD_ADAPT_EXP = 0.40f;
static const float TOD_ADAPT_MAX = 24.0f;

// ---------------------------------------------------------------- small helpers
static inline vec3 tod_mul(const vec3& a, const vec3& b) { return vec3(a.x*b.x, a.y*b.y, a.z*b.z); }
static inline vec3 tod_exp(const vec3& a) { return vec3(expf(a.x), expf(a.y), expf(a.z)); }
static inline float tod_lum(const vec3& c) { return 0.2126f*c.x + 0.7152f*c.y + 0.0722f*c.z; }
static inline float tod_smooth(float a, float b, float x) {
    float t = clampf((x - a) / (b - a), 0.f, 1.f);
    return t * t * (3.f - 2.f * t);
}

/**
 * Relative optical air mass, Kasten-Young 1989.
 *
 * The naive 1/sin(elevation) is off by 10% at 10 degrees and diverges at 0; Kasten-Young is the
 * standard fit that stays finite, reaching about 38 at the horizon. It is only valid above the
 * horizon -- extended below it the fit turns non-monotonic, which would put a fold in the sun's
 * colour -- so the elevation is clamped at zero. That clamp is invisible because the direct beam
 * has already faded out by then and the sky is on its twilight decay.
 */
static inline float tod_airMass(float elevDeg) {
    float e = elevDeg < 0.f ? 0.f : elevDeg;
    float am = 1.f / (sinf(e * TOD_D2R) + 0.50572f * powf(e + 6.07995f, -1.6364f));
    return am < TOD_AIRMASS_MAX ? am : TOD_AIRMASS_MAX;
}

/** Aerosol column optical depth per channel at the given haze. */
static inline vec3 tod_aerosolDepth(float haze) {
    return TOD_AEROSOL_SHAPE * (TOD_AEROSOL_BASE + TOD_AEROSOL_HAZE * clampf(haze, 0.f, 1.f));
}

// ---------------------------------------------------------------- the model
//
// Split out from skyAt() only so that skyAt() can call it once at noon to get the reference
// illumination its exposure hint is relative to, without recursing.
static inline SkyState tod_state(float hours, float haze) {
    haze = clampf(haze, 0.f, 1.f);

    // ---- solar position
    //
    // Hour angle: 15 degrees per hour, zero at local solar noon. `hours` wraps, and the wrap has
    // to be exact rather than approximately right, because 24 -> 0 is where a discontinuity would
    // hide: it is the one place the sun's azimuth passes through due north and the whole
    // construction changes sign.
    float h = fmodf(hours, 24.f);
    if (h < 0.f) h += 24.f;
    float H = (h - 12.f) * 15.f * TOD_D2R;

    float sinLat = sinf(TOD_LATITUDE_DEG * TOD_D2R), cosLat = cosf(TOD_LATITUDE_DEG * TOD_D2R);
    float sinDec = sinf(TOD_DECLINATION_DEG * TOD_D2R), cosDec = cosf(TOD_DECLINATION_DEG * TOD_D2R);

    // Elevation follows a sine of the hour angle, peaking at noon, exactly as the standard
    // spherical-triangle solution gives. The two horizontal components come from the same
    // triangle. Building the direction from components rather than from an azimuth angle avoids
    // an atan2 and, more importantly, avoids the branch near due north where a naive
    // asin(sinAz) picks the wrong quadrant -- which is precisely the midnight wrap above.
    float up    = sinLat * sinDec + cosLat * cosDec * cosf(H);      // = sin(elevation)
    float north = sinDec * cosLat - sinLat * cosDec * cosf(H);      // = cos(el) * cos(azimuth)
    float east  = -cosDec * sinf(H);                                // = cos(el) * sin(azimuth)
    // north^2 + east^2 == 1 - up^2 identically, so this vector is already unit length; vnorm
    // only mops up float error.

    // World axes are +X east, +Y up, +Z south -- the usual right-handed graphics frame with
    // north at -Z. `sunDir` is the direction light *travels*, so it is the negation of the
    // direction to the sun, and points downward whenever the sun is up.
    vec3 toSun = vnorm(vec3(east, up, -north));

    float elevDeg = asinf(clampf(toSun.y, -1.f, 1.f)) / TOD_D2R;
    float airMass = tod_airMass(elevDeg);
    vec3 aer = tod_aerosolDepth(haze);
    vec3 tau = TOD_TAU_RAYLEIGH + aer;
    vec3 T = tod_exp(-(tau * airMass));         // per-channel transmittance of the direct beam
    float Tlum = tod_lum(T);

    SkyState s;
    s.sunDir = -toSun;

    // ---- direct sun
    //
    // Colour is entirely T; only the scalar fade is hand-chosen, and a scalar cannot change the
    // hue, so the reddening is air mass and nothing else.
    float sunUp = tod_smooth(-TOD_SUN_FADE_DEG, TOD_SUN_FADE_DEG, elevDeg);
    s.sunColor = T * (TOD_SUN_IRRADIANCE * sunUp);

    // ---- sky
    //
    // Single-scatter slab: radiance from a direction that looks through `m` air masses is the
    // sunlight that got here (T), times the share of that column's scattering that actually
    // ends up coming at the eye (omega), times how much of the column the eye sees into
    // (1 - exp(-tau*m)). The last factor is the whole reason the horizon and the zenith differ:
    // the zenith path is thin, so only the most-scattered wavelength (blue) accumulates, while
    // the horizon path is thick enough to saturate in every channel and so comes out pale. Add
    // the multiply-scattered term described above, and the sunset zenith stays blue while the
    // sunset horizon burns.
    vec3 sct = TOD_TAU_RAYLEIGH + aer * TOD_MIE_ISOTROPIC;
    vec3 omega = vec3(sct.x / tau.x, sct.y / tau.y, sct.z / tau.z);
    vec3 lit = tod_mul(omega, T);
    vec3 ms  = TOD_MS_CHROMA * Tlum;

    vec3 one(1.f, 1.f, 1.f);
    vec3 hSat = one - tod_exp(-(tau * TOD_VIEW_AM_HORIZON));
    vec3 zSat = one - tod_exp(-(tau * TOD_VIEW_AM_ZENITH));

    vec3 horizon = (tod_mul(lit, hSat) + ms * TOD_MS_GAIN_H) * TOD_SKY_GAIN_H;
    vec3 zenith  = (tod_mul(lit, zSat) + ms * TOD_MS_GAIN_Z) * TOD_SKY_GAIN_Z;

    // Twilight decay, then the night floor added on top.
    float depression = elevDeg < 0.f ? -elevDeg : 0.f;
    float twilight = powf(10.f, -depression / TOD_TWILIGHT_DECADE_DEG);
    horizon = horizon * twilight + TOD_NIGHT_HORIZON;
    zenith  = zenith  * twilight + TOD_NIGHT_ZENITH;

    // ---- haze on the sky
    //
    // Looking through more scattering medium destroys colour, because every photon that reaches
    // you has been redirected so many times that its origin no longer matters. So the horizon is
    // pulled toward its own grey, and the zenith is pulled toward the *horizon's* colour -- in
    // thick fog there is no zenith blue left to see, the whole dome is one uniform luminous
    // sheet. The small brightness lift is the same effect from the other side: fog is bright
    // because it scatters light back at you. It is multiplicative, so foggy midnight stays dark.
    float greyH = tod_lum(horizon);
    horizon = vlerp(horizon, vec3(greyH, greyH, greyH), 0.80f * haze) * (1.f + 0.40f * haze);
    zenith  = vlerp(zenith, horizon, 0.85f * haze);

    s.skyHorizon = horizon;
    s.skyZenith  = zenith;

    // ---- ambient
    //
    // The sky colours above already carry the day-to-night brightness change, so this term must
    // not repeat it or night ends up dark twice over. It stays near the 0.55 the daytime maps
    // use, and only lifts where the renderer's single-bounce ambient under-reads: with no direct
    // light at all the sky is the entire light source, and in fog the light arrives from
    // everywhere at once rather than from one direction.
    s.ambient = clampf(0.55f + 0.14f * (1.f - sunUp) + 0.12f * haze, 0.f, 0.9f);

    s.fogDensity = TOD_FOG_CLEAR * powf(TOD_FOG_HEAVY / TOD_FOG_CLEAR, haze);

    s.exposureHint = 1.f;   // filled in by skyAt()
    return s;
}

/**
 * Illumination proxy: roughly what the scene as a whole receives, sun plus sky.
 *
 * The sun's share is 60% of the irradiance on a *horizontal* surface plus 40% of its
 * unattenuated strength. That second term is not a fudge: a scene of warehouses, quay walls and
 * vehicle flanks is mostly vertical, and a low sun hits a vertical surface at close to full
 * strength while contributing almost nothing to the ground. A pure horizontal measure treats
 * the golden hour as nearly dark and exposes it up by 2.1x, which is exactly backwards -- the
 * blazing side-lit facades are the whole point of that hour. With the vertical term included
 * the same moment gets 1.6x, and midnight is unaffected because the sun is off entirely.
 */
static inline float tod_illuminance(const SkyState& s) {
    float cosSun = s.sunDir.y < 0.f ? -s.sunDir.y : 0.f;
    // Recovered from sunDir with the same smoothstep tod_state() used, rather than a step at
    // elevation zero -- a step here would be a jump in exposureHint at the exact moment the sun
    // sets, which is a whole-screen brightness pop and the single most visible artifact this
    // file could ship.
    float elev = asinf(clampf(-s.sunDir.y, -1.f, 1.f)) / TOD_D2R;
    float sunUp = tod_smooth(-TOD_SUN_FADE_DEG, TOD_SUN_FADE_DEG, elev);
    // The 1.6 matches the chunk shader's own `skyAmb` scale, so this proxy is measuring the same
    // quantity the renderer will actually light with rather than an idealised one.
    return tod_lum(s.sunColor) * (0.60f * cosSun + 0.40f * sunUp)
         + 1.6f * s.ambient * tod_lum((s.skyHorizon + s.skyZenith) * 0.5f);
}

/**
 * @param hours  0..24, wrapping. 12 = noon, 0 = midnight.
 * @param haze   0 = clear, 1 = heavy fog. Scales fogDensity and pulls the sky toward grey.
 */
static inline SkyState skyAt(float hours, float haze = 0.0f) {
    SkyState s = tod_state(hours, haze);
    // The reference is this model's own clear-air noon, computed once, rather than a constant
    // copied out of a spreadsheet -- so `exposureHint` stays exactly 1.0 at midday even if the
    // atmosphere constants above are retuned, instead of silently drifting off it.
    static const float ref = tod_illuminance(tod_state(12.f, 0.f));
    s.exposureHint = clampf(powf(ref / (tod_illuminance(s) + 1e-6f), TOD_ADAPT_EXP), 1.f, TOD_ADAPT_MAX);
    return s;
}
